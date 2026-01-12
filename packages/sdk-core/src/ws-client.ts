import { EventEmitter } from "./events.ts";
import { camelToSnake, snakeToCamel } from "./transforms.ts";
import { createLogger, type Logger } from "./utils/logger.ts";
import type {
	ChalkError,
	ChatMessage,
	Participant,
	Reaction,
	RoomSnapshot,
	TokenProvider,
} from "./types.ts";

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
const HEARTBEAT_INTERVAL = 30000;
// SDKCORE-LOW-01: Timeout threshold (2 missed pongs = timeout)
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 2.5;

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
	"whiteboard.data": {
		participantId: string;
		displayName: string;
		elements: unknown[];
		files?: Record<string, unknown>;
		seq: number;
		timestamp: Date;
	};
	"whiteboard.snapshot": {
		roomId: string;
		elements: unknown[];
		files: Record<string, unknown>;
		appState: Record<string, unknown>;
		lastSeq: number;
	};
	"whiteboard.cursor": {
		participantId: string;
		displayName: string;
		x: number;
		y: number;
		timestamp: Date;
	};
	"permission.changed": {
		participantId: string;
		feature: string;
		canDraw: boolean;
		grantedBy: string;
		timestamp: Date;
	};
	"whiteboard.opened": {
		participantId: string;
		displayName: string;
		timestamp: Date;
	};
	"whiteboard.closed": {
		participantId: string;
		timestamp: Date;
	};
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
	private readonly log: Logger = createLogger("WebSocket");

	constructor(wsUrl: string, _debug = false, tokenProvider?: TokenProvider) {
		super();
		this.wsUrl = wsUrl;
		this.tokenProvider = tokenProvider;
	}

	get connectionState(): ConnectionState {
		return this.state;
	}

	get lastPongReceived(): number {
		return this.lastPongTime;
	}

	connect(token: string, roomId: string): void {
		if (this.state === "connected" || this.state === "connecting") {
			this.log.debug("Already connected or connecting");
			return;
		}

		this.token = token;
		this.roomId = roomId;
		this.state = "connecting";
		this.doConnect();
	}

	private doConnect(): void {
		if (!this.token || !this.roomId) return;

		let url = this.wsUrl;
		try {
			const parsed = new URL(this.wsUrl);
			// Pass token via query param (primary auth method)
			parsed.searchParams.set("token", this.token);
			parsed.searchParams.set("room", this.roomId);
			url = parsed.toString();
		} catch {
			const separator = this.wsUrl.includes("?") ? "&" : "?";
			url = `${this.wsUrl}${separator}token=${encodeURIComponent(this.token)}&room=${encodeURIComponent(this.roomId)}`;
		}
		this.log.info("Connecting", { url: this.wsUrl });

		try {
			// Also pass token via subprotocol as fallback
			const protocols = ["chalk", `token.${this.token}`];
			this.ws = new WebSocket(url, protocols);
			this.setupEventHandlers();
		} catch (error) {
			this.log.error("Connection error", { error });
			this.handleConnectionFailure();
		}
	}

	private setupEventHandlers(): void {
		if (!this.ws) return;

		this.ws.onopen = () => {
			this.log.info("Connected");
			this.state = "connected";
			this.reconnectAttempt = 0;
			this.startHeartbeat();
			this.emit("connected", undefined);
		};

		this.ws.onclose = (event) => {
			this.log.info("Disconnected", { code: event.code, reason: event.reason });
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
			this.log.warn("WebSocket error", { event });
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
			this.log.debug("Received", {
				type: rawMessage.type,
				payloadPreview: JSON.stringify(rawMessage.payload).substring(0, 200),
			});

			const payload = rawMessage.payload
				? snakeToCamel<Record<string, unknown>>(rawMessage.payload)
				: undefined;

			switch (rawMessage.type) {
				case "participant.joined": {
					// Backend sends {participant: {...}}, extract nested object
					const joinedPayload = payload as { participant?: Record<string, unknown> };
					const participantData = joinedPayload.participant ?? payload;
					this.emit(
						"participant.joined",
						this.transformParticipant(participantData as Record<string, unknown>),
					);
					break;
				}
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
					// Map backend field names to frontend ChatMessage interface
					this.log.debug("Chat message received", { payload });
					const rawPayload = payload as {
						id: string;
						participantId: string;
						displayName: string;
						content: string;
						timestamp: string;
					};
					const chatMessage: ChatMessage = {
						id: rawPayload.id,
						senderId: rawPayload.participantId,
						senderName: rawPayload.displayName,
						content: rawPayload.content,
						timestamp: new Date(rawPayload.timestamp),
					};
					this.log.debug("Chat message emitting", { id: chatMessage.id, senderId: chatMessage.senderId });
					this.emit("chat.message", chatMessage);
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
				case "whiteboard.data": {
					const data = payload as WSEvents["whiteboard.data"];
					this.log.debug("Whiteboard data received", {
						participantId: data.participantId,
						displayName: data.displayName,
						seq: data.seq,
						elementsCount: Array.isArray(data.elements) ? data.elements.length : "unknown",
					});
					this.emit("whiteboard.data", {
						...data,
						timestamp: new Date(data.timestamp),
					});
					break;
				}
				case "whiteboard.snapshot":
					this.log.debug("Whiteboard snapshot received", { roomId: (payload as { roomId: string }).roomId });
					this.emit(
						"whiteboard.snapshot",
						payload as WSEvents["whiteboard.snapshot"],
					);
					break;
				case "whiteboard.cursor":
					// Don't log cursor - too noisy
					this.emit("whiteboard.cursor", {
						...(payload as WSEvents["whiteboard.cursor"]),
						timestamp: new Date(
							(payload as { timestamp: string }).timestamp,
						),
					});
					break;
				case "permission.changed": {
					const data = payload as WSEvents["permission.changed"];
					this.log.debug("Permission changed", { participantId: data.participantId, feature: data.feature, canDraw: data.canDraw });
					this.emit("permission.changed", {
						...data,
						timestamp: new Date(data.timestamp),
					});
					break;
				}
				case "whiteboard.opened": {
					const data = payload as WSEvents["whiteboard.opened"];
					this.log.debug("Whiteboard opened", { participantId: data.participantId, displayName: data.displayName });
					this.emit("whiteboard.opened", {
						...data,
						timestamp: new Date(data.timestamp),
					});
					break;
				}
				case "whiteboard.closed": {
					const data = payload as WSEvents["whiteboard.closed"];
					this.log.debug("Whiteboard closed", { participantId: data.participantId });
					this.emit("whiteboard.closed", {
						...data,
						timestamp: new Date(data.timestamp),
					});
					break;
				}
				default:
					this.log.warn("Unknown message type", { type: rawMessage.type });
			}
		} catch (error) {
			this.log.error("Failed to parse message", { error });
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
			this.log.error("Max reconnect attempts reached");
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

		this.log.info("Reconnecting", { delayMs: delay, attempt: this.reconnectAttempt });
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
				this.log.debug("Refreshing token before reconnect");
				this.token = await this.tokenProvider();
				this.log.info("Token refreshed successfully");
			} catch (error) {
				this.log.error("Token refresh failed", { error });
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
		this.lastPongTime = Date.now();
		this.heartbeatTimer = setInterval(() => {
			// SDKCORE-LOW-01: Check for heartbeat timeout
			const timeSinceLastPong = Date.now() - this.lastPongTime;
			if (timeSinceLastPong > HEARTBEAT_TIMEOUT) {
				this.log.warn("Heartbeat timeout - no pong received", {
					timeSinceLastPong,
					threshold: HEARTBEAT_TIMEOUT,
				});
				this.handleConnectionFailure();
				return;
			}
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
			const jsonMsg = JSON.stringify(transformedMessage);
			this.log.debug("Sending", { type: message.type, messageLength: jsonMsg.length });
			this.ws.send(jsonMsg);
		} else {
			this.log.warn("Send failed", { type: message.type, readyState: this.ws?.readyState, OPEN: WebSocket.OPEN });
		}
	}

	// Client-to-server actions
	sendChatMessage(content: string): void {
		this.log.debug("Chat message sending", { contentLength: content.length, readyState: this.ws?.readyState, OPEN: WebSocket.OPEN });
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
		this.log.info("Disconnecting");
		this.state = "disconnected";
		this.stopHeartbeat();

		if (this.ws) {
			this.ws.close(1000, "Client disconnect");
			this.ws = null;
		}

		this.token = null;
		this.roomId = null;
	}

	// Whiteboard methods
	sendWhiteboardUpdate(
		elements: unknown[],
		files?: Record<string, unknown>,
		seq?: number,
	): void {
		this.log.debug("Whiteboard update sending", {
			elementsCount: elements.length,
			hasFiles: !!files,
			seq: seq ?? Date.now(),
		});
		this.send({
			type: "whiteboard.update",
			payload: { elements, files, seq: seq ?? Date.now() },
		});
	}

	sendWhiteboardCursor(x: number, y: number): void {
		// Don't log cursor - too noisy
		this.send({
			type: "whiteboard.cursor",
			payload: { x, y },
		});
	}

	sendWhiteboardClear(): void {
		this.log.debug("Whiteboard clear sending");
		this.send({ type: "whiteboard.clear", payload: {} });
	}

	requestWhiteboardSync(): void {
		this.log.debug("Whiteboard sync request sending");
		this.send({ type: "whiteboard.sync", payload: {} });
	}

	grantWhiteboardPermission(participantId: string): void {
		this.log.debug("Whiteboard permission grant sending", { participantId });
		this.send({
			type: "permission.grant",
			payload: { participantId, feature: "whiteboard" },
		});
	}

	revokeWhiteboardPermission(participantId: string): void {
		this.log.debug("Whiteboard permission revoke sending", { participantId });
		this.send({
			type: "permission.revoke",
			payload: { participantId, feature: "whiteboard" },
		});
	}

	sendWhiteboardOpen(): void {
		this.log.debug("Whiteboard open sending");
		this.send({ type: "whiteboard.open", payload: {} });
	}

	sendWhiteboardClose(): void {
		this.log.debug("Whiteboard close sending");
		this.send({ type: "whiteboard.close", payload: {} });
	}
}
