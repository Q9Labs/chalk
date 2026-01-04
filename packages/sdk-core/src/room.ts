/**
 * Room class - main interface for interacting with a video room
 * Wraps Cloudflare RealtimeKit for WebRTC and WSClient for signaling
 */

import type RealtimeKitClient from "@cloudflare/realtimekit";
import { EventEmitter } from "./events.ts";
import type {
	ChalkError,
	ChatMessage,
	MediaDevice,
	MediaDeviceKind,
	Participant,
	Reaction,
	ReactionEmoji,
	Recording,
	RoomInfo,
	RoomStatus,
	ScreenShareOptions,
	TokenSet,
} from "./types.ts";
import { ChalkErrorCode } from "./types.ts";
import type { WSClient } from "./ws-client.ts";

interface RoomEvents {
	"status-changed": RoomStatus;
	"participant-joined": Participant;
	"participant-left": string;
	"participant-updated": { participantId: string; participant: Participant };
	"active-speaker-changed": Participant | null;
	"chat-message": ChatMessage;
	reaction: Reaction;
	"hand-raised": { participantId: string };
	"hand-lowered": { participantId: string };
	"recording-started": { recordingId: string };
	"recording-stopped": Recording;
	error: ChalkError;
}

export class Room extends EventEmitter<RoomEvents> {
	readonly id: string;
	private _status: RoomStatus = "disconnected";
	private _info: RoomInfo | null = null;
	private _participants: Map<string, Participant> = new Map();
	private _localParticipant: Participant | null = null;
	private _activeSpeaker: Participant | null = null;
	private _messages: ChatMessage[] = [];
	private _currentRecording: { id: string } | null = null;
	private _tokens: TokenSet | null = null;

	private rtkClient?: RealtimeKitClient;
	private wsClient?: WSClient;
	private readonly debug: boolean;

	constructor(
		roomId: string,
		wsClientOrRtkClient?: WSClient | RealtimeKitClient,
		debug = false,
	) {
		super();
		this.id = roomId;
		this.debug = debug;

		// Support both WSClient and RealtimeKitClient for backwards compatibility
		if (wsClientOrRtkClient) {
			if ("connect" in wsClientOrRtkClient) {
				// It's a WSClient
				this.wsClient = wsClientOrRtkClient as WSClient;
				this.setupWSListeners();
			} else {
				// It's a RealtimeKitClient
				this.rtkClient = wsClientOrRtkClient as RealtimeKitClient;
				this.setupRTKListeners();
			}
		}
	}

	private log(...args: unknown[]): void {
		if (this.debug) {
			console.log("[Chalk Room]", ...args);
		}
	}

	// Getters
	get status(): RoomStatus {
		return this._status;
	}

	get info(): RoomInfo | null {
		return this._info;
	}

	get participants(): Map<string, Participant> {
		return new Map(this._participants);
	}

	get localParticipant(): Participant | null {
		return this._localParticipant;
	}

	get activeSpeaker(): Participant | null {
		return this._activeSpeaker;
	}

	get messages(): ChatMessage[] {
		return [...this._messages];
	}

	get isRecording(): boolean {
		return this._currentRecording !== null;
	}

	// Internal methods
	_setStatus(status: RoomStatus): void {
		if (this._status !== status) {
			this._status = status;
			this.emit("status-changed", status);
		}
	}

	_setInfo(info: RoomInfo): void {
		this._info = info;
	}

	_setLocalParticipant(participant: Participant): void {
		this._localParticipant = participant;
		this._participants.set(participant.id, participant);
	}

	_setTokens(tokens: TokenSet): void {
		this._tokens = tokens;
	}

	get tokens(): TokenSet | null {
		return this._tokens;
	}

	private setupWSListeners(): void {
		if (!this.wsClient) return;

		this.wsClient.on("connected", () => {
			this.log("WebSocket connected");
			this._setStatus("connected");
		});

		this.wsClient.on("disconnected", () => {
			this.log("WebSocket disconnected");
			this._setStatus("disconnected");
		});

		this.wsClient.on("reconnecting", () => {
			this.log("WebSocket reconnecting");
			this._setStatus("reconnecting");
		});

		this.wsClient.on("participant.joined", (data) => {
			this.log("Participant joined:", data.displayName);
			this._participants.set(data.id, data);
			this.emit("participant-joined", data);
		});

		this.wsClient.on("participant.left", (data) => {
			this.log("Participant left:", data.participantId);
			const participant = this._participants.get(data.participantId);
			this._participants.delete(data.participantId);
			if (participant) {
				this.emit("participant-left", data.participantId);
			}
		});

		this.wsClient.on("participant.updated", (data) => {
			const participant = this._participants.get(data.participantId);
			if (participant) {
				const updated = { ...participant, ...data.changes };
				this._participants.set(data.participantId, updated);
				this.emit("participant-updated", {
					participantId: data.participantId,
					participant: updated,
				});
			}
		});

		this.wsClient.on("chat.message", (data) => {
			this._messages.push(data);
			this.emit("chat-message", data);
		});

		this.wsClient.on("reaction", (data) => {
			this.emit("reaction", data);
		});

		this.wsClient.on("hand.raised", (data) => {
			const participant = this._participants.get(data.participantId);
			if (participant) {
				participant.handRaised = true;
				this.emit("participant-updated", {
					participantId: data.participantId,
					participant,
				});
			}
			this.emit("hand-raised", { participantId: data.participantId });
		});

		this.wsClient.on("hand.lowered", (data) => {
			const participant = this._participants.get(data.participantId);
			if (participant) {
				participant.handRaised = false;
				this.emit("participant-updated", {
					participantId: data.participantId,
					participant,
				});
			}
			this.emit("hand-lowered", { participantId: data.participantId });
		});

		this.wsClient.on("recording.started", (data) => {
			this._currentRecording = { id: data.recordingId };
			this.emit("recording-started", { recordingId: data.recordingId });
		});

		this.wsClient.on("recording.stopped", (data) => {
			const recording: Recording = {
				id: this._currentRecording?.id ?? data.recordingId,
				roomId: this.id,
				status: "processing",
				durationSeconds: data.duration,
			};
			this._currentRecording = null;
			this.emit("recording-stopped", recording);
		});

		this.wsClient.on("error", (data) => {
			this.emit("error", {
				code: data.code,
				message: data.message,
			});
		});

		this.wsClient.on("room.snapshot", (snapshot) => {
			this.log(
				"Received room snapshot:",
				snapshot.participants.length,
				"participants",
			);

			this._participants.clear();

			for (const p of snapshot.participants) {
				if (this._localParticipant && p.id === this._localParticipant.id) {
					continue;
				}
				this._participants.set(p.id, p);
				this.emit("participant-joined", p);
			}

			if (this._localParticipant) {
				this._participants.set(
					this._localParticipant.id,
					this._localParticipant,
				);
			}

			if (snapshot.isRecording && snapshot.recordingId) {
				this._currentRecording = { id: snapshot.recordingId };
			}
		});
	}

	/**
	 * Map a RealtimeKit participant to Chalk Participant type
	 */
	private mapRTKParticipant(rtkParticipant: unknown): Participant {
		const p = rtkParticipant as {
			id: string;
			name?: string;
			videoEnabled?: boolean;
			audioEnabled?: boolean;
			videoTrack?: MediaStreamTrack;
			audioTrack?: MediaStreamTrack;
			screenShareEnabled?: boolean;
			screenShareTracks?: {
				audio?: MediaStreamTrack;
				video?: MediaStreamTrack;
			};
		};

		return {
			id: p.id,
			displayName: p.name ?? "Unknown",
			role: "participant",
			isLocal: false,
			videoEnabled: p.videoEnabled ?? false,
			audioEnabled: p.audioEnabled ?? false,
			videoTrack: p.videoTrack,
			audioTrack: p.audioTrack,
			screenShareTrack: p.screenShareTracks?.video,
			isSpeaking: false,
			isScreenSharing: p.screenShareEnabled ?? false,
			handRaised: false,
			connectionQuality: 100,
		};
	}

	private setupRTKListeners(): void {
		if (!this.rtkClient) return;

		// Room joined event
		this.rtkClient.self.on("roomJoined", () => {
			this.log("Room joined");
			this._setStatus("connected");

			// Sync local participant state with RTK
			if (this._localParticipant) {
				this._localParticipant.videoEnabled = this.rtkClient!.self.videoEnabled;
				this._localParticipant.audioEnabled = this.rtkClient!.self.audioEnabled;
				this._localParticipant.videoTrack =
					this.rtkClient!.self.videoTrack ?? undefined;
				this._localParticipant.audioTrack =
					this.rtkClient!.self.audioTrack ?? undefined;
			}
		});

		// Room left event
		this.rtkClient.self.on("roomLeft", () => {
			this.log("Room left");
			this._setStatus("disconnected");
		});

		// Video update for local user
		this.rtkClient.self.on(
			"videoUpdate",
			(data: {
				videoEnabled: boolean;
				videoTrack: MediaStreamTrack | null;
			}) => {
				this.log("Local video update:", data.videoEnabled);
				if (this._localParticipant) {
					this._localParticipant.videoEnabled = data.videoEnabled;
					this._localParticipant.videoTrack = data.videoTrack ?? undefined;
					this.emit("participant-updated", {
						participantId: this._localParticipant.id,
						participant: this._localParticipant,
					});
				}
			},
		);

		// Audio update for local user
		this.rtkClient.self.on(
			"audioUpdate",
			(data: {
				audioEnabled: boolean;
				audioTrack: MediaStreamTrack | null;
			}) => {
				this.log("Local audio update:", data.audioEnabled);
				if (this._localParticipant) {
					this._localParticipant.audioEnabled = data.audioEnabled;
					this._localParticipant.audioTrack = data.audioTrack ?? undefined;
					this.emit("participant-updated", {
						participantId: this._localParticipant.id,
						participant: this._localParticipant,
					});
				}
			},
		);

		// Screen share update for local user
		this.rtkClient.self.on(
			"screenShareUpdate",
			(data: {
				screenShareEnabled: boolean;
				screenShareTracks: {
					audio?: MediaStreamTrack;
					video?: MediaStreamTrack;
				};
			}) => {
				this.log("Local screen share update:", data.screenShareEnabled);
				if (this._localParticipant) {
					this._localParticipant.isScreenSharing = data.screenShareEnabled;
					this._localParticipant.screenShareTrack =
						data.screenShareTracks?.video ?? undefined;
					this.emit("participant-updated", {
						participantId: this._localParticipant.id,
						participant: this._localParticipant,
					});
				}
			},
		);

		// Participant joined
		this.rtkClient.participants.joined.on(
			"participantJoined",
			(rtkParticipant: unknown) => {
				const participant = this.mapRTKParticipant(rtkParticipant);
				this.log("Participant joined:", participant.displayName);
				this._participants.set(participant.id, participant);
				this.emit("participant-joined", participant);
			},
		);

		// Participant left
		this.rtkClient.participants.joined.on(
			"participantLeft",
			(rtkParticipant: unknown) => {
				const p = rtkParticipant as { id: string };
				this.log("Participant left:", p.id);
				this._participants.delete(p.id);
				this.emit("participant-left", p.id);
			},
		);

		// Participant video update
		this.rtkClient.participants.joined.on(
			"videoUpdate",
			(rtkParticipant: unknown) => {
				const participant = this.mapRTKParticipant(rtkParticipant);
				const existing = this._participants.get(participant.id);
				if (existing) {
					existing.videoEnabled = participant.videoEnabled;
					existing.videoTrack = participant.videoTrack;
					this.emit("participant-updated", {
						participantId: participant.id,
						participant: existing,
					});
				}
			},
		);

		// Participant audio update
		this.rtkClient.participants.joined.on(
			"audioUpdate",
			(rtkParticipant: unknown) => {
				const participant = this.mapRTKParticipant(rtkParticipant);
				const existing = this._participants.get(participant.id);
				if (existing) {
					existing.audioEnabled = participant.audioEnabled;
					existing.audioTrack = participant.audioTrack;
					this.emit("participant-updated", {
						participantId: participant.id,
						participant: existing,
					});
				}
			},
		);

		// Participant screen share update
		this.rtkClient.participants.joined.on(
			"screenShareUpdate",
			(rtkParticipant: unknown) => {
				const participant = this.mapRTKParticipant(rtkParticipant);
				const existing = this._participants.get(participant.id);
				if (existing) {
					this.log("Participant screen share update:", participant.id, participant.isScreenSharing);
					existing.isScreenSharing = participant.isScreenSharing;
					existing.screenShareTrack = participant.screenShareTrack;
					
					// Validate screen share track
					if (participant.isScreenSharing && !participant.screenShareTrack) {
						this.log("Warning: Screen sharing enabled but no track available for", participant.id);
					}
					
					this.emit("participant-updated", {
						participantId: participant.id,
						participant: existing,
					});
				} else {
					this.log("Warning: Screen share update for unknown participant:", participant.id);
				}
			},
		);

		this.setupActiveSpeakerListener();
	}

	private setupActiveSpeakerListener(): void {
		if (!this.rtkClient?.participants) return;

		const participants = this.rtkClient.participants as unknown as {
			on?: (event: string, handler: (speaker: unknown) => void) => void;
		};

		if (typeof participants.on !== "function") return;

		participants.on("activeSpeakerChanged", (speaker: unknown) => {
			if (speaker) {
				const speakerId = (speaker as { id: string }).id;
				const participant = this._participants.get(speakerId) ?? null;
				if (this._activeSpeaker?.id !== participant?.id) {
					this._activeSpeaker = participant;
					this.emit("active-speaker-changed", participant);
				}
			} else {
				if (this._activeSpeaker !== null) {
					this._activeSpeaker = null;
					this.emit("active-speaker-changed", null);
				}
			}
		});
	}

	// Media controls using RealtimeKit
	async toggleVideo(): Promise<boolean> {
		if (!this.rtkClient || !this._localParticipant) {
			return false;
		}

		try {
			if (this.rtkClient.self.videoEnabled) {
				await this.rtkClient.self.disableVideo();
				this._localParticipant.videoEnabled = false;
				this._localParticipant.videoTrack = undefined;
			} else {
				await this.rtkClient.self.enableVideo();
				this._localParticipant.videoEnabled = true;
				this._localParticipant.videoTrack =
					this.rtkClient.self.videoTrack ?? undefined;
			}
			return this._localParticipant.videoEnabled;
		} catch (error) {
			this.log("Failed to toggle video:", error);
			this.emit("error", {
				code: "MEDIA_ERROR",
				message: "Failed to toggle camera",
			});
			return this._localParticipant.videoEnabled;
		}
	}

	async toggleAudio(): Promise<boolean> {
		if (!this.rtkClient || !this._localParticipant) {
			return false;
		}

		try {
			if (this.rtkClient.self.audioEnabled) {
				await this.rtkClient.self.disableAudio();
				this._localParticipant.audioEnabled = false;
				this._localParticipant.audioTrack = undefined;
			} else {
				await this.rtkClient.self.enableAudio();
				this._localParticipant.audioEnabled = true;
				this._localParticipant.audioTrack =
					this.rtkClient.self.audioTrack ?? undefined;
			}
			return this._localParticipant.audioEnabled;
		} catch (error) {
			this.log("Failed to toggle audio:", error);
			this.emit("error", {
				code: "MEDIA_ERROR",
				message: "Failed to toggle microphone",
			});
			return this._localParticipant.audioEnabled;
		}
	}

	async startScreenShare(_options?: ScreenShareOptions): Promise<boolean> {
		if (!this._localParticipant || !this.rtkClient) return false;

		if (this._localParticipant.isScreenSharing) return true;

		try {
			await this.rtkClient.self.enableScreenShare();
			this._localParticipant.isScreenSharing = true;
			return true;
		} catch (error) {
			this.log("Failed to start screen share:", error);
			this.emit("error", {
				code: "SCREEN_SHARE_ERROR",
				message: "Failed to start screen sharing",
			});
			return false;
		}
	}

	async stopScreenShare(): Promise<void> {
		if (!this._localParticipant || !this.rtkClient) return;

		if (!this._localParticipant.isScreenSharing) return;

		try {
			await this.rtkClient.self.disableScreenShare();
			this._localParticipant.isScreenSharing = false;
			this._localParticipant.screenShareTrack = undefined;
		} catch (error) {
			this.log("Failed to stop screen share:", error);
		}
	}

	// ===== Device Management =====

	/**
	 * Get list of available media devices
	 */
	async getDevices(): Promise<MediaDevice[]> {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			return devices.map((d) => ({
				deviceId: d.deviceId,
				label: d.label || `${d.kind} (${d.deviceId.slice(0, 8)})`,
				kind: d.kind as MediaDeviceKind,
			}));
		} catch (error) {
			this.log("Failed to enumerate devices:", error);
			this.emit("error", {
				code: ChalkErrorCode.MEDIA_ERROR,
				message: "Failed to list media devices",
			});
			return [];
		}
	}

	/**
	 * Get available video input devices (cameras)
	 */
	async getCameras(): Promise<MediaDevice[]> {
		const devices = await this.getDevices();
		return devices.filter((d) => d.kind === "videoinput");
	}

	/**
	 * Get available audio input devices (microphones)
	 */
	async getMicrophones(): Promise<MediaDevice[]> {
		const devices = await this.getDevices();
		return devices.filter((d) => d.kind === "audioinput");
	}

	/**
	 * Get available audio output devices (speakers)
	 */
	async getSpeakers(): Promise<MediaDevice[]> {
		const devices = await this.getDevices();
		return devices.filter((d) => d.kind === "audiooutput");
	}

	/**
	 * Switch to a different camera
	 */
	async selectCamera(deviceId: string): Promise<boolean> {
		if (!this.rtkClient || !this._localParticipant) return false;

		try {
			// Use setDevice if available, otherwise re-enable with new device
			const self = this.rtkClient.self as unknown as {
				setDevice?: (kind: string, deviceId: string) => Promise<void>;
				videoTrack?: MediaStreamTrack;
			};

			if (typeof self.setDevice === "function") {
				await self.setDevice("video", deviceId);
			} else {
				// Fallback: disable and re-enable with new device
				if (this.rtkClient.self.videoEnabled) {
					await this.rtkClient.self.disableVideo();
				}
				await (
					this.rtkClient.self.enableVideo as (opts?: unknown) => Promise<void>
				)({ videoDevice: deviceId });
			}
			this._localParticipant.videoEnabled = true;
			this._localParticipant.videoTrack =
				(self.videoTrack as MediaStreamTrack | undefined) ?? undefined;
			return true;
		} catch (error) {
			this.log("Failed to select camera:", error);
			this.emit("error", {
				code: ChalkErrorCode.DEVICE_NOT_FOUND,
				message: "Failed to switch camera",
				details: { deviceId },
			});
			return false;
		}
	}

	/**
	 * Switch to a different microphone
	 */
	async selectMicrophone(deviceId: string): Promise<boolean> {
		if (!this.rtkClient || !this._localParticipant) return false;

		try {
			const self = this.rtkClient.self as unknown as {
				setDevice?: (kind: string, deviceId: string) => Promise<void>;
				audioTrack?: MediaStreamTrack;
			};

			if (typeof self.setDevice === "function") {
				await self.setDevice("audio", deviceId);
			} else {
				if (this.rtkClient.self.audioEnabled) {
					await this.rtkClient.self.disableAudio();
				}
				await (
					this.rtkClient.self.enableAudio as (opts?: unknown) => Promise<void>
				)({ audioDevice: deviceId });
			}
			this._localParticipant.audioEnabled = true;
			this._localParticipant.audioTrack =
				(self.audioTrack as MediaStreamTrack | undefined) ?? undefined;
			return true;
		} catch (error) {
			this.log("Failed to select microphone:", error);
			this.emit("error", {
				code: ChalkErrorCode.DEVICE_NOT_FOUND,
				message: "Failed to switch microphone",
				details: { deviceId },
			});
			return false;
		}
	}

	// Chat
	sendMessage(content: string): void {
		if (!content.trim()) return;

		const trimmed = content.trim();

		// Try WSClient first, fallback to RealtimeKit
		if (this.wsClient) {
			this.wsClient.sendChatMessage(trimmed);
		} else if (this.rtkClient) {
			try {
				this.rtkClient.chat?.sendTextMessage(trimmed);
			} catch {
				this.log("Chat not available");
			}
		}
	}

	// Reactions
	sendReaction(emoji: ReactionEmoji): void {
		// Try WSClient first, fallback to RealtimeKit
		if (this.wsClient) {
			this.wsClient.sendReaction(emoji);
		} else if (this.rtkClient) {
			try {
				// RealtimeKit may have reactions API
				(
					this.rtkClient as unknown as {
						reactions?: { send: (e: string) => void };
					}
				).reactions?.send(emoji);
			} catch {
				this.log("Reactions not available");
			}
		}
	}

	// Hand raise
	raiseHand(): void {
		if (!this._localParticipant) return;

		this._localParticipant.handRaised = true;

		// Try WSClient first
		if (this.wsClient) {
			this.wsClient.raiseHand();
		}

		this.emit("hand-raised", { participantId: this._localParticipant.id });
	}

	lowerHand(): void {
		if (!this._localParticipant) return;

		this._localParticipant.handRaised = false;

		// Try WSClient first
		if (this.wsClient) {
			this.wsClient.lowerHand();
		}

		this.emit("hand-lowered", { participantId: this._localParticipant.id });
	}

	// Disconnect
	leave(): void {
		this.log("Leaving room");

		// Disconnect WSClient if present
		if (this.wsClient) {
			this.wsClient.disconnect();
		}

		// Disconnect RealtimeKit if present
		try {
			if (this.rtkClient) {
				this.rtkClient.leave();
			}
		} catch {
			// Ignore errors during leave
		}

		// Clear state
		this._participants.clear();
		this._activeSpeaker = null;
		this._messages = [];
		this._currentRecording = null;
		this._localParticipant = null;

		this._setStatus("disconnected");
	}

	/**
	 * Get the underlying RealtimeKit client for advanced usage
	 */
	get rtkMeeting(): RealtimeKitClient | undefined {
		return this.rtkClient;
	}
}
