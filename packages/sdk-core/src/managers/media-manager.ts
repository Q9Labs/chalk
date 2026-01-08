/**
 * Media manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { Room } from "../room";
import { StateContainer } from "../state/state-container";
import type { MediaDevice } from "../types/entities/media";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** Media manager state */
export interface MediaState {
	/** Whether video is enabled */
	readonly isVideoEnabled: boolean;
	/** Whether audio is enabled */
	readonly isAudioEnabled: boolean;
	/** Whether video toggle is in progress */
	readonly isTogglingVideo: boolean;
	/** Whether audio toggle is in progress */
	readonly isTogglingAudio: boolean;
	/** Selected camera device ID */
	readonly selectedCamera: string | null;
	/** Selected microphone device ID */
	readonly selectedMicrophone: string | null;
	/** Selected speaker device ID */
	readonly selectedSpeaker: string | null;
	/** All available devices */
	readonly devices: readonly MediaDevice[];
}

/** Media manager events */
export interface MediaManagerEvents {
	/** Video state changed */
	"video:changed": { enabled: boolean; track: MediaStreamTrack | null };
	/** Audio state changed */
	"audio:changed": { enabled: boolean; track: MediaStreamTrack | null };
	/** Device list changed */
	"devices:changed": { devices: readonly MediaDevice[] };
	/** Error occurred */
	error: ChalkError;
}

interface PreviousDevice {
	type: "camera" | "microphone";
	id: string;
}

/**
 * Manages video/audio toggle and device selection
 */
export class MediaManager extends StateContainer<MediaState> {
	private readonly events = new TypedEventEmitter<MediaManagerEvents>();
	private room: Room | null = null;
	private toggleLock = false;
	private undoTimeout: ReturnType<typeof setTimeout> | null = null;
	private previousDevice: PreviousDevice | null = null;

	constructor() {
		super({
			isVideoEnabled: false,
			isAudioEnabled: false,
			isTogglingVideo: false,
			isTogglingAudio: false,
			selectedCamera: null,
			selectedMicrophone: null,
			selectedSpeaker: null,
			devices: [],
		});
	}

	/** Subscribe to media events */
	on<K extends keyof MediaManagerEvents>(
		event: K,
		handler: (data: MediaManagerEvents[K]) => void,
	): () => void {
		return this.events.on(event, handler);
	}

	/** Attach Room instance */
	attachRoom(room: Room): void {
		this.room = room;
		this.syncFromRoom();
	}

	private syncFromRoom(): void {
		if (!this.room?.localParticipant) return;

		this.setState({
			isVideoEnabled: this.room.localParticipant.videoEnabled ?? false,
			isAudioEnabled: this.room.localParticipant.audioEnabled ?? false,
		});
	}

	/** Toggle video on/off */
	async toggleVideo(): Promise<boolean> {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		if (this.toggleLock) {
			return this.getState().isVideoEnabled;
		}

		this.toggleLock = true;
		this.setState({ isTogglingVideo: true });

		try {
			const result = await this.room.toggleVideo();
			const track = this.room.localParticipant?.videoTrack ?? null;

			this.setState({ isVideoEnabled: result });
			this.events.emit("video:changed", { enabled: result, track });

			return result;
		} catch (err) {
			const error = ChalkError.wrap(err);
			this.events.emit("error", error);
			throw error;
		} finally {
			this.setState({ isTogglingVideo: false });
			this.toggleLock = false;
		}
	}

	/** Toggle audio on/off */
	async toggleAudio(): Promise<boolean> {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		if (this.toggleLock) {
			return this.getState().isAudioEnabled;
		}

		this.toggleLock = true;
		this.setState({ isTogglingAudio: true });

		try {
			const result = await this.room.toggleAudio();
			const track = this.room.localParticipant?.audioTrack ?? null;

			this.setState({ isAudioEnabled: result });
			this.events.emit("audio:changed", { enabled: result, track });

			return result;
		} catch (err) {
			const error = ChalkError.wrap(err);
			this.events.emit("error", error);
			throw error;
		} finally {
			this.setState({ isTogglingAudio: false });
			this.toggleLock = false;
		}
	}

	/** Select a camera by device ID */
	async selectCamera(deviceId: string): Promise<void> {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		// Store previous for undo
		this.previousDevice = {
			type: "camera",
			id: this.getState().selectedCamera ?? "",
		};

		await this.room.selectCamera(deviceId);
		this.setState({ selectedCamera: deviceId });
		this.startUndoTimer();
	}

	/** Select a microphone by device ID */
	async selectMicrophone(deviceId: string): Promise<void> {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		// Store previous for undo
		this.previousDevice = {
			type: "microphone",
			id: this.getState().selectedMicrophone ?? "",
		};

		await this.room.selectMicrophone(deviceId);
		this.setState({ selectedMicrophone: deviceId });
		this.startUndoTimer();
	}

	/** Select a speaker by device ID */
	async selectSpeaker(deviceId: string): Promise<void> {
		// Speaker selection doesn't go through Room - it's handled by audio elements
		this.setState({ selectedSpeaker: deviceId });
	}

	/** Undo the last device change (within 5s window) */
	undoDeviceChange(): void {
		if (!this.previousDevice || !this.undoTimeout || !this.room) {
			return;
		}

		clearTimeout(this.undoTimeout);

		if (this.previousDevice.type === "camera") {
			this.room.selectCamera(this.previousDevice.id);
			this.setState({ selectedCamera: this.previousDevice.id });
		} else if (this.previousDevice.type === "microphone") {
			this.room.selectMicrophone(this.previousDevice.id);
			this.setState({ selectedMicrophone: this.previousDevice.id });
		}

		this.previousDevice = null;
		this.undoTimeout = null;
	}

	private startUndoTimer(): void {
		if (this.undoTimeout) {
			clearTimeout(this.undoTimeout);
		}

		this.undoTimeout = setTimeout(() => {
			this.previousDevice = null;
			this.undoTimeout = null;
		}, 5000);
	}

	/** Refresh available devices */
	async refreshDevices(): Promise<readonly MediaDevice[]> {
		try {
			const rawDevices = await navigator.mediaDevices.enumerateDevices();
			const devices: MediaDevice[] = rawDevices
				.filter((d) =>
					["videoinput", "audioinput", "audiooutput"].includes(d.kind),
				)
				.map((d) => ({
					deviceId: d.deviceId,
					label: d.label || `${d.kind} (${d.deviceId.slice(0, 8)})`,
					kind: d.kind as "videoinput" | "audioinput" | "audiooutput",
				}));

			this.setState({ devices });
			this.events.emit("devices:changed", { devices });

			return devices;
		} catch (err) {
			const error = ChalkError.wrap(err);
			this.events.emit("error", error);
			throw error;
		}
	}

	/** Get available cameras */
	get cameras(): readonly MediaDevice[] {
		return this.getState().devices.filter((d) => d.kind === "videoinput");
	}

	/** Get available microphones */
	get microphones(): readonly MediaDevice[] {
		return this.getState().devices.filter((d) => d.kind === "audioinput");
	}

	/** Get available speakers */
	get speakers(): readonly MediaDevice[] {
		return this.getState().devices.filter((d) => d.kind === "audiooutput");
	}

	/** Cleanup resources */
	dispose(): void {
		if (this.undoTimeout) {
			clearTimeout(this.undoTimeout);
		}
		this.events.removeAllListeners();
	}
}
