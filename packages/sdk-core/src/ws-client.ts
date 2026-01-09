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

		let url = this.wsUrl;
		try {
			const parsed = new URL(this.wsUrl);
			parsed.searchParams.delete("token");
			parsed.searchParams.delete("authToken");
			parsed.searchParams.delete("accessToken");
			parsed.searchParams.set("room", this.roomId);
			url = parsed.toString();
		} catch {
			const separator = this.wsUrl.includes("?") ? "&" : "?";
			url = `${this.wsUrl}${separator}room=${encodeURIComponent(this.roomId)}`;
		}
		this.log("Connecting to", this.wsUrl);

		try {
			const protocols = ["chalk", `token.${this.token}`];
			this.ws = new WebSocket(url, protocols);
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
			this.log("[WS Recv]", rawMessage.type, JSON.stringify(rawMessage.payload).substring(0, 200));

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
					this.log("[Chat] Received raw payload:", JSON.stringify(payload));
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
					this.log("[Chat] Emitting chat.message:", JSON.stringify(chatMessage));
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
				case "whiteboard.data":
					console.log("[WS-CLIENT] Received whiteboard.data:", {
						participantId: (payload as WSEvents["whiteboard.data"]).participantId,
						displayName: (payload as WSEvents["whiteboard.data"]).displayName,
						seq: (payload as WSEvents["whiteboard.data"]).seq,
						elementsCount: Array.isArray((payload as WSEvents["whiteboard.data"]).elements)
							? (payload as WSEvents["whiteboard.data"]).elements.length
							: "unknown",
					});
					this.emit("whiteboard.data", {
						...(payload as WSEvents["whiteboard.data"]),
						timestamp: new Date(
							(payload as { timestamp: string }).timestamp,
						),
					});
					break;
				case "whiteboard.snapshot":
					console.log("[WS-CLIENT] Received whiteboard.snapshot:", payload);
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
				case "permission.changed":
					console.log("[WS-CLIENT] Received permission.changed:", payload);
					this.emit("permission.changed", {
						...(payload as WSEvents["permission.changed"]),
						timestamp: new Date(
							(payload as { timestamp: string }).timestamp,
						),
					});
					break;
				case "whiteboard.opened":
					console.log("[WS-CLIENT] Received whiteboard.opened:", payload);
					this.emit("whiteboard.opened", {
						...(payload as WSEvents["whiteboard.opened"]),
						timestamp: new Date(
							(payload as { timestamp: string }).timestamp,
						),
					});
					break;
				case "whiteboard.closed":
					console.log("[WS-CLIENT] Received whiteboard.closed:", payload);
					this.emit("whiteboard.closed", {
						...(payload as WSEvents["whiteboard.closed"]),
						timestamp: new Date(
							(payload as { timestamp: string }).timestamp,
						),
					});
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
			const jsonMsg = JSON.stringify(transformedMessage);
			this.log("[WS Send]", jsonMsg);
			this.ws.send(jsonMsg);
		} else {
			this.log("[WS Send] FAILED - not connected, state:", this.ws?.readyState);
		}
	}

	// Client-to-server actions
	sendChatMessage(content: string): void {
		this.log("[Chat] Sending message:", content);
		this.log("[Chat] WebSocket state:", this.ws?.readyState, "OPEN=", WebSocket.OPEN);
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

	// Whiteboard methods
	sendWhiteboardUpdate(
		elements: unknown[],
		files?: Record<string, unknown>,
		seq?: number,
	): void {
		console.log("[WS-CLIENT] Sending whiteboard.update:", {
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
		console.log("[WS-CLIENT] Sending whiteboard.clear");
		this.send({ type: "whiteboard.clear", payload: {} });
	}

	requestWhiteboardSync(): void {
		console.log("[WS-CLIENT] Sending whiteboard.sync request");
		this.send({ type: "whiteboard.sync", payload: {} });
	}

	grantWhiteboardPermission(participantId: string): void {
		console.log("[WS-CLIENT] Sending permission.grant:", { participantId });
		this.send({
			type: "permission.grant",
			payload: { participantId, feature: "whiteboard" },
		});
	}

	revokeWhiteboardPermission(participantId: string): void {
		console.log("[WS-CLIENT] Sending permission.revoke:", { participantId });
		this.send({
			type: "permission.revoke",
			payload: { participantId, feature: "whiteboard" },
		});
	}

	sendWhiteboardOpen(): void {
		console.log("[WS-CLIENT] Sending whiteboard.open");
		this.send({ type: "whiteboard.open", payload: {} });
	}

	sendWhiteboardClose(): void {
		console.log("[WS-CLIENT] Sending whiteboard.close");
		this.send({ type: "whiteboard.close", payload: {} });
	}
}
