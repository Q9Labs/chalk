/**
 * Room class - main interface for interacting with a video room
 * Wraps Cloudflare RealtimeKit for WebRTC functionality
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
} from "./types.ts";
import { ChalkErrorCode } from "./types.ts";

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
	private _status: RoomStatus = "connecting";
	private _info: RoomInfo | null = null;
	private _participants: Map<string, Participant> = new Map();
	private _localParticipant: Participant;
	private _activeSpeaker: Participant | null = null;
	private _messages: ChatMessage[] = [];
	private _currentRecording: { id: string } | null = null;

	private readonly rtkClient: RealtimeKitClient;
	private readonly debug: boolean;

	constructor(
		roomId: string,
		rtkClient: RealtimeKitClient,
		localParticipant: Participant,
		debug = false,
	) {
		super();
		this.id = roomId;
		this.rtkClient = rtkClient;
		this._localParticipant = localParticipant;
		this._participants.set(localParticipant.id, localParticipant);
		this.debug = debug;
		this.setupRTKListeners();
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

	get localParticipant(): Participant {
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
			isSpeaking: false,
			isScreenSharing: p.screenShareEnabled ?? false,
			handRaised: false,
			connectionQuality: 100,
		};
	}

	private setupRTKListeners(): void {
		// Room joined event
		this.rtkClient.self.on("roomJoined", () => {
			this.log("Room joined");
			this._setStatus("connected");

			// Sync local participant state with RTK
			this._localParticipant.videoEnabled = this.rtkClient.self.videoEnabled;
			this._localParticipant.audioEnabled = this.rtkClient.self.audioEnabled;
			this._localParticipant.videoTrack =
				this.rtkClient.self.videoTrack ?? undefined;
			this._localParticipant.audioTrack =
				this.rtkClient.self.audioTrack ?? undefined;
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
				this._localParticipant.videoEnabled = data.videoEnabled;
				this._localParticipant.videoTrack = data.videoTrack ?? undefined;
				this.emit("participant-updated", {
					participantId: this._localParticipant.id,
					participant: this._localParticipant,
				});
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
				this._localParticipant.audioEnabled = data.audioEnabled;
				this._localParticipant.audioTrack = data.audioTrack ?? undefined;
				this.emit("participant-updated", {
					participantId: this._localParticipant.id,
					participant: this._localParticipant,
				});
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

		// Note: Active speaker detection would need to be implemented using audioUpdate events
		// and checking for isSpeaking property or using a voice activity detection library
	}

	// Media controls using RealtimeKit
	async toggleVideo(): Promise<boolean> {
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
		if (!this._localParticipant.isScreenSharing) return;

		try {
			await this.rtkClient.self.disableScreenShare();
			this._localParticipant.isScreenSharing = false;
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

	// Chat (using RealtimeKit chat if available, fallback to noop)
	sendMessage(content: string): void {
		if (!content.trim()) return;
		try {
			this.rtkClient.chat?.sendTextMessage(content.trim());
		} catch {
			this.log("Chat not available");
		}
	}

	// Reactions
	sendReaction(emoji: ReactionEmoji): void {
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

	// Hand raise (custom implementation via metadata or API)
	raiseHand(): void {
		this._localParticipant.handRaised = true;
		this.emit("hand-raised", { participantId: this._localParticipant.id });
	}

	lowerHand(): void {
		this._localParticipant.handRaised = false;
		this.emit("hand-lowered", { participantId: this._localParticipant.id });
	}

	// Disconnect
	leave(): void {
		this.log("Leaving room");

		try {
			this.rtkClient.leave();
		} catch {
			// Ignore errors during leave
		}

		// Clear state
		this._participants.clear();
		this._activeSpeaker = null;
		this._messages = [];
		this._currentRecording = null;

		this._setStatus("disconnected");
	}

	/**
	 * Get the underlying RealtimeKit client for advanced usage
	 */
	get rtkMeeting(): RealtimeKitClient {
		return this.rtkClient;
	}
}
