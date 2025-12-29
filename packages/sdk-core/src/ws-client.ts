import { EventEmitter } from "./events.ts";
import { camelToSnake, snakeToCamel } from "./transforms.ts";
import type {
	ChalkError,
	ChatMessage,
	Participant,
	Reaction,
	RoomSnapshot,
	TokenProvider,
} from "./types.ts";

const DEFAULT_WS_URL = "ws://localhost:8080/ws";
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
const HEARTBEAT_INTERVAL = 30000;

type ConnectionState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "failed";

interface WSEvents {
	connected: void;
	disconnected: { reason?: string };
	reconnecting: { attempt: number };
	error: ChalkError;
	"token-expired": ChalkError;
	"participant.joined": Participant;
	"participant.left": { participantId: string };
	"participant.updated": {
		participantId: string;
		changes: Partial<Participant>;
	};
	"chat.message": ChatMessage;
	reaction: Reaction;
	"hand.raised": { participantId: string };
	"hand.lowered": { participantId: string };
	"recording.started": { recordingId: string };
	"recording.stopped": { recordingId: string; duration: number };
	"room.updated": { roomId: string; changes: Record<string, unknown> };
	"room.snapshot": RoomSnapshot;
	registered: {
		participantId: string;
		roomId: string;
		tenantId: string;
	};
	"room-sync": RoomSnapshot;
}

export class WSClient extends EventEmitter<WSEvents> {
	private ws: WebSocket | null = null;
	private readonly wsUrl: string;
	private readonly tokenProvider?: TokenProvider;
	private token: string | null = null;
	private roomId: string | null = null;
	private state: ConnectionState = "disconnected";
	private reconnectAttempt = 0;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private lastPongTime: number = Date.now();
	private readonly debug: boolean;

	constructor(wsUrl?: string, debug = false, tokenProvider?: TokenProvider) {
		super();
		this.wsUrl = wsUrl ?? DEFAULT_WS_URL;
		this.debug = debug;
		this.tokenProvider = tokenProvider;
	}

	private log(...args: unknown[]): void {
		if (this.debug) {
			console.log("[Chalk WS]", ...args);
		}
	}

	get connectionState(): ConnectionState {
		return this.state;
	}

	get lastPongReceived(): number {
		return this.lastPongTime;
	}

	connect(token: string, roomId: string): void {
		if (this.state === "connected" || this.state === "connecting") {
			this.log("Already connected or connecting");
			return;
		}

		this.token = token;
		this.roomId = roomId;
		this.state = "connecting";
		this.doConnect();
	}

	private doConnect(): void {
		if (!this.token || !this.roomId) return;

		const url = `${this.wsUrl}?token=${encodeURIComponent(this.token)}&room=${encodeURIComponent(this.roomId)}`;
		this.log("Connecting to", this.wsUrl);

		try {
			this.ws = new WebSocket(url);
			this.setupEventHandlers();
		} catch (error) {
			this.log("Connection error:", error);
			this.handleConnectionFailure();
		}
	}

	private setupEventHandlers(): void {
		if (!this.ws) return;

		this.ws.onopen = () => {
			this.log("Connected");
			this.state = "connected";
			this.reconnectAttempt = 0;
			this.startHeartbeat();
			this.emit("connected", undefined);
		};

		this.ws.onclose = (event) => {
			this.log("Disconnected:", event.code, event.reason);
			this.stopHeartbeat();

			if (this.state === "connected") {
				// Unexpected disconnection - try to reconnect
				this.handleConnectionFailure();
			} else {
				this.state = "disconnected";
				this.emit("disconnected", { reason: event.reason });
			}
		};

		this.ws.onerror = (event) => {
			this.log("WebSocket error:", event);
			this.emit("error", {
				code: "WS_ERROR",
				message: "WebSocket connection error",
			});
		};

		this.ws.onmessage = (event) => {
			this.handleMessage(event.data);
		};
	}

	private handleMessage(data: string): void {
		try {
			const rawMessage = JSON.parse(data);
			this.log("Received:", rawMessage.type);

			const payload = rawMessage.payload
				? snakeToCamel<Record<string, unknown>>(rawMessage.payload)
				: undefined;

			switch (rawMessage.type) {
				case "participant.joined":
					this.emit(
						"participant.joined",
						this.transformParticipant(payload as Record<string, unknown>),
					);
					break;
				case "participant.left":
					this.emit("participant.left", payload as { participantId: string });
					break;
				case "participant.updated":
					this.emit(
						"participant.updated",
						payload as {
							participantId: string;
							changes: Partial<Participant>;
						},
					);
					break;
				case "chat.message": {
					const chatPayload = payload as unknown as ChatMessage;
					this.emit("chat.message", {
						...chatPayload,
						timestamp: new Date(chatPayload.timestamp as unknown as string),
					});
					break;
				}
				case "reaction": {
					const reactionPayload = payload as unknown as Reaction;
					this.emit("reaction", {
						...reactionPayload,
						timestamp: new Date(reactionPayload.timestamp as unknown as string),
					});
					break;
				}
				case "hand.raised":
					this.emit("hand.raised", payload as { participantId: string });
					break;
				case "hand.lowered":
					this.emit("hand.lowered", payload as { participantId: string });
					break;
				case "recording.started":
					this.emit("recording.started", payload as { recordingId: string });
					break;
				case "recording.stopped":
					this.emit(
						"recording.stopped",
						payload as { recordingId: string; duration: number },
					);
					break;
				case "room.updated":
					this.emit(
						"room.updated",
						payload as { roomId: string; changes: Record<string, unknown> },
					);
					break;
				case "room.snapshot":
					this.emit("room.snapshot", this.transformSnapshot(payload));
					break;
				case "ping":
					this.send({ type: "pong" });
					break;
				case "pong":
					this.lastPongTime = Date.now();
					break;
				case "connected":
					this.emit(
						"registered",
						payload as {
							participantId: string;
							roomId: string;
							tenantId: string;
						},
					);
					break;
				case "room.sync":
					this.emit("room-sync", this.transformSnapshot(payload));
					break;
				case "error":
					this.emit("error", payload as unknown as ChalkError);
					break;
				default:
					this.log("Unknown message type:", rawMessage.type);
			}
		} catch (error) {
			this.log("Failed to parse message:", error);
		}
	}

	private transformParticipant(p: Record<string, unknown>): Participant {
		return {
			id: p.id as string,
			displayName: p.displayName as string,
			role: (p.role as Participant["role"]) ?? "participant",
			isLocal: false,
			videoEnabled: (p.videoEnabled as boolean) ?? false,
			audioEnabled: (p.audioEnabled as boolean) ?? false,
			isSpeaking: false,
			isScreenSharing: (p.isScreenSharing as boolean) ?? false,
			handRaised: (p.handRaised as boolean) ?? false,
			connectionQuality: 100,
		};
	}

	private transformSnapshot(payload: unknown): RoomSnapshot {
		const p = payload as {
			roomId: string;
			participants: Array<Record<string, unknown>>;
			isRecording: boolean;
			recordingId?: string;
			lastSeq: number;
		};
		return {
			roomId: p.roomId,
			participants: p.participants.map((participant) =>
				this.transformParticipant(participant),
			),
			isRecording: p.isRecording,
			recordingId: p.recordingId,
			lastSeq: p.lastSeq,
		};
	}

	private handleConnectionFailure(): void {
		this.stopHeartbeat();

		if (this.reconnectAttempt >= RECONNECT_DELAYS.length) {
			this.log("Max reconnect attempts reached");
			this.state = "failed";
			this.emit("error", {
				code: "MAX_RECONNECT_ATTEMPTS",
				message: "Failed to reconnect after multiple attempts",
			});
			return;
		}

		this.state = "reconnecting";
		const delay =
			RECONNECT_DELAYS[this.reconnectAttempt] ??
			RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1]!;
		this.reconnectAttempt++;

		this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
		this.emit("reconnecting", { attempt: this.reconnectAttempt });

		setTimeout(async () => {
			if (this.state === "reconnecting") {
				await this.refreshTokenAndConnect();
			}
		}, delay);
	}

	private async refreshTokenAndConnect(): Promise<void> {
		if (this.tokenProvider) {
			try {
				this.log("Refreshing token before reconnect");
				this.token = await this.tokenProvider();
				this.log("Token refreshed successfully");
			} catch (error) {
				this.log("Token refresh failed:", error);
				const chalkError: ChalkError = {
					code: "TOKEN_EXPIRED",
					message:
						error instanceof Error
							? error.message
							: "Failed to refresh token for WebSocket reconnection",
				};
				this.emit("token-expired", chalkError);
				this.state = "failed";
				return;
			}
		}

		this.doConnect();
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			this.send({ type: "ping" });
		}, HEARTBEAT_INTERVAL);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	send(message: Record<string, unknown>): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			const transformedMessage = {
				type: message.type,
				payload: message.payload
					? camelToSnake(message.payload)
					: message.payload,
			};
			this.ws.send(JSON.stringify(transformedMessage));
		} else {
			this.log("Cannot send message - not connected");
		}
	}

	// Client-to-server actions
	sendChatMessage(content: string): void {
		this.send({ type: "chat.send", payload: { content } });
	}

	sendReaction(emoji: string): void {
		this.send({ type: "reaction.send", payload: { emoji } });
	}

	raiseHand(): void {
		this.send({ type: "hand.raise", payload: {} });
	}

	lowerHand(): void {
		this.send({ type: "hand.lower", payload: {} });
	}

	disconnect(): void {
		this.log("Disconnecting");
		this.state = "disconnected";
		this.stopHeartbeat();

		if (this.ws) {
			this.ws.close(1000, "Client disconnect");
			this.ws = null;
		}

		this.token = null;
		this.roomId = null;
	}
}
