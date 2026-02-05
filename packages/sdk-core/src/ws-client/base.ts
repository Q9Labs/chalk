import { EventEmitter } from "../events.ts";
import type { TokenProvider } from "../types.ts";
import { wideEvents, type WideEventContext } from "../wide-events/index.ts";

import {
	closeCodeMap,
	type ConnectionState,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	RECONNECT_DELAYS_MS,
} from "./constants.ts";
import { decodeIncomingMessage } from "./decoder.ts";
import {
	defaultTimers,
	defaultWebSocketFactory,
	type Timers,
	type WSClientOptions,
} from "./deps.ts";
import type { WSOutboundMessage } from "./messages.ts";
import { serializeOutgoingMessage } from "./outbound.ts";
import { createInboundHandlers } from "./inbound-handlers.ts";
import type { WSEvents } from "./emitted-events.ts";
import { buildWsUrl } from "./url.ts";
import { toWsError } from "./ws-error.ts";

export class WSClientBase extends EventEmitter<WSEvents> {
	private ws: WebSocket | null = null;
	private readonly wsUrl: string;
	private readonly tokenProvider?: TokenProvider;
	private token: string | null = null;
	private roomId: string | null = null;
	private state: ConnectionState = "disconnected";
	private reconnectAttempt = 0;
	private heartbeatTimer: ReturnType<Timers["setInterval"]> | null = null;
	private reconnectTimer: ReturnType<Timers["setTimeout"]> | null = null;
	private lastPongTime: number = Date.now();
	private connectContext: WideEventContext | null = null;
	private lastCloseEvent: { code: number; reason: string; wasClean: boolean } | null =
		null;

	protected readonly now: () => number;
	private readonly webSocketFactory: typeof defaultWebSocketFactory;
	private readonly timers: Timers;
	private readonly inboundHandlers: ReturnType<typeof createInboundHandlers>;

	constructor(wsUrl: string, options: WSClientOptions = {}) {
		super();
		this.wsUrl = wsUrl;
		this.tokenProvider = options.tokenProvider;
		this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
		this.timers = options.timers ?? defaultTimers;
		this.now = options.now ?? Date.now;

		this.inboundHandlers = createInboundHandlers({
			emit: (event, data) => this.emit(event, data),
			send: (message) => this.send(message),
			now: () => this.now(),
			setLastPongTime: (ts) => {
				this.lastPongTime = ts;
			},
		});
	}

	get connectionState(): ConnectionState {
		return this.state;
	}

	get lastPongReceived(): number {
		return this.lastPongTime;
	}

	get lastClose(): { code: number; reason: string; wasClean: boolean } | null {
		return this.lastCloseEvent;
	}

	connect(token: string, roomId: string): void {
		if (this.state === "connected" || this.state === "connecting") {
			return;
		}

		this.token = token;
		this.roomId = roomId;
		this.state = "connecting";

		this.connectContext = wideEvents.start("websocket.connect");
		this.connectContext.set("roomId", roomId);
		this.connectContext.set("wsUrl", this.wsUrl);

		this.doConnect();
	}

	private doConnect(): void {
		if (!this.token || !this.roomId) return;

		const url = buildWsUrl(this.wsUrl, this.token, this.roomId);
		this.connectContext?.set("attempt", this.reconnectAttempt + 1);

		try {
			const protocols = ["chalk", `token.${this.token}`];
			this.ws = this.webSocketFactory(url, protocols);
			this.setupEventHandlers();
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			this.connectContext?.complete("error", {
				errorCode: "WS_CONNECTION_ERROR",
				errorMessage,
			});
			this.connectContext = null;
			this.handleConnectionFailure();
		}
	}

	private setupEventHandlers(): void {
		if (!this.ws) return;

		this.ws.onopen = () => {
			this.state = "connected";
			this.reconnectAttempt = 0;
			this.stopReconnectTimer();
			this.startHeartbeat();

			this.connectContext?.complete("success");
			this.connectContext = null;

			this.emit("connected", undefined);
		};

		this.ws.onclose = (event) => {
			const codeDescription = closeCodeMap[event.code] ?? "Unknown close code";
			this.lastCloseEvent = {
				code: event.code,
				reason: event.reason || codeDescription,
				wasClean: event.wasClean,
			};

			this.stopHeartbeat();
			this.ws = null;

			if (this.state === "disconnected") {
				this.emit("disconnected", { reason: event.reason || codeDescription });
				return;
			}

			this.handleConnectionFailure();
		};

		this.ws.onerror = (event) => {
			this.emit("error", toWsError(event, this.ws));
		};

		this.ws.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			this.handleIncoming(event.data);
		};
	}

	private handleIncoming(raw: string): void {
		const decoded = decodeIncomingMessage(raw);
		if (!decoded.ok) {
			this.emit("error", {
				code: "WS_PARSE_ERROR",
				message: "Failed to parse WebSocket message",
				details: decoded.error,
			});
			return;
		}
		if (!decoded.known) {
			return;
		}

		const handler = this.inboundHandlers[decoded.message.type];
		handler?.(decoded.message.payload as never);
	}

	private handleConnectionFailure(): void {
		this.stopHeartbeat();

		if (this.state === "failed" || this.state === "reconnecting") {
			return;
		}

		if (this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
			this.state = "failed";

			if (this.connectContext) {
				this.connectContext.complete("error", {
					errorCode: "MAX_RECONNECT_ATTEMPTS",
					errorMessage: "Failed to reconnect after multiple attempts",
				});
				this.connectContext = null;
			}

			const ctx = wideEvents.start("websocket.disconnect");
			ctx.set("roomId", this.roomId);
			ctx.set("reason", "max_reconnect_attempts");
			ctx.complete("error", {
				errorCode: "MAX_RECONNECT_ATTEMPTS",
				errorMessage: "Failed to reconnect after multiple attempts",
			});

			this.emit("error", {
				code: "MAX_RECONNECT_ATTEMPTS",
				message: "Failed to reconnect after multiple attempts",
			});
			return;
		}

		this.state = "reconnecting";
		const delay =
			RECONNECT_DELAYS_MS[this.reconnectAttempt] ??
			RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]!;
		this.reconnectAttempt++;

		this.emit("reconnecting", { attempt: this.reconnectAttempt });

		this.stopReconnectTimer();
		this.reconnectTimer = this.timers.setTimeout(() => {
			if (this.state === "reconnecting") {
				void this.refreshTokenAndConnect();
			}
		}, delay);
	}

	private stopReconnectTimer(): void {
		if (this.reconnectTimer) {
			this.timers.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private async refreshTokenAndConnect(): Promise<void> {
		if (this.tokenProvider) {
			try {
				this.token = await this.tokenProvider();
			} catch (err) {
				this.emit("token-expired", {
					code: "TOKEN_EXPIRED",
					message:
						err instanceof Error
							? err.message
							: "Failed to refresh token for WebSocket reconnection",
				});
				this.state = "failed";
				return;
			}
		}

		this.doConnect();
	}

	private startHeartbeat(): void {
		this.lastPongTime = this.now();
		this.heartbeatTimer = this.timers.setInterval(() => {
			const timeSinceLastPong = this.now() - this.lastPongTime;
			if (timeSinceLastPong > HEARTBEAT_TIMEOUT_MS) {
				this.handleConnectionFailure();
				return;
			}
			this.send({ type: "ping" });
		}, HEARTBEAT_INTERVAL_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			this.timers.clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	send(message: WSOutboundMessage): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		try {
			this.ws.send(serializeOutgoingMessage(message));
		} catch (err) {
			this.emit("error", {
				code: "WS_SEND_ERROR",
				message: err instanceof Error ? err.message : "Failed to send WS message",
			});
		}
	}

	disconnect(): void {
		const ctx = wideEvents.start("websocket.disconnect");
		ctx.set("roomId", this.roomId);
		ctx.set("reason", "client_initiated");
		ctx.complete("success");

		this.state = "disconnected";
		this.stopHeartbeat();
		this.stopReconnectTimer();

		if (this.ws) {
			this.ws.close(1000, "Client disconnect");
			this.ws = null;
		}

		this.token = null;
		this.roomId = null;
	}
}
