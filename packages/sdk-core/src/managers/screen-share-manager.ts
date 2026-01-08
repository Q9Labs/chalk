/**
 * Screen share manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { Room } from "../room";
import { StateContainer } from "../state/state-container";
import type { ScreenShareOptions } from "../types/entities/media";
import { TypedEventEmitter } from "../utils/typed-emitter";

/** Screen share manager state */
export interface ScreenShareState {
	/** Whether screen share is active */
	readonly isActive: boolean;
	/** Whether screen share is starting */
	readonly isStarting: boolean;
	/** Participant ID who is sharing (null if no one) */
	readonly sharerParticipantId: string | null;
	/** Screen share video track */
	readonly videoTrack: MediaStreamTrack | null;
	/** Screen share audio track (if available) */
	readonly audioTrack: MediaStreamTrack | null;
}

/** Screen share manager events */
export interface ScreenShareManagerEvents {
	/** Screen share started */
	started: { participantId: string; isLocal: boolean };
	/** Screen share stopped */
	stopped: { participantId: string };
	/** Error occurred */
	error: ChalkError;
}

/**
 * Manages screen sharing
 */
export class ScreenShareManager extends StateContainer<ScreenShareState> {
	private readonly events = new TypedEventEmitter<ScreenShareManagerEvents>();
	private room: Room | null = null;

	constructor() {
		super({
			isActive: false,
			isStarting: false,
			sharerParticipantId: null,
			videoTrack: null,
			audioTrack: null,
		});
	}

	/** Subscribe to screen share events */
	on<K extends keyof ScreenShareManagerEvents>(
		event: K,
		handler: (data: ScreenShareManagerEvents[K]) => void,
	): () => void {
		return this.events.on(event, handler);
	}

	/** Attach Room instance */
	attachRoom(room: Room): void {
		this.room = room;
		this.setupRoomListeners();
		this.syncFromRoom();
	}

	private syncFromRoom(): void {
		if (!this.room) return;

		// Check if local user is screen sharing
		const localParticipant = this.room.localParticipant;
		if (localParticipant?.isScreenSharing) {
			this.setState({
				isActive: true,
				sharerParticipantId: localParticipant.id,
				videoTrack: localParticipant.screenShareTrack ?? null,
				audioTrack: localParticipant.screenShareAudioTrack ?? null,
			});
			return;
		}

		// Check if any remote participant is screen sharing
		for (const [, participant] of this.room.participants) {
			if (participant.isScreenSharing) {
				this.setState({
					isActive: true,
					sharerParticipantId: participant.id,
					videoTrack: participant.screenShareTrack ?? null,
					audioTrack: participant.screenShareAudioTrack ?? null,
				});
				return;
			}
		}
	}

	private setupRoomListeners(): void {
		if (!this.room) return;

		this.room.on("participant-updated", ({ participantId, participant }) => {
			const wasSharing = this.getState().sharerParticipantId === participantId;
			const isNowSharing = participant.isScreenSharing;

			if (!wasSharing && isNowSharing) {
				// Started sharing
				const isLocal = participant.isLocal;
				this.setState({
					isActive: true,
					sharerParticipantId: participantId,
					videoTrack: participant.screenShareTrack ?? null,
					audioTrack: participant.screenShareAudioTrack ?? null,
				});
				this.events.emit("started", { participantId, isLocal });
			} else if (wasSharing && !isNowSharing) {
				// Stopped sharing
				this.setState({
					isActive: false,
					sharerParticipantId: null,
					videoTrack: null,
					audioTrack: null,
				});
				this.events.emit("stopped", { participantId });
			} else if (wasSharing && isNowSharing) {
				// Update tracks
				this.setState({
					videoTrack: participant.screenShareTrack ?? null,
					audioTrack: participant.screenShareAudioTrack ?? null,
				});
			}
		});

		this.room.on("participant-left", (participantId) => {
			if (this.getState().sharerParticipantId === participantId) {
				this.setState({
					isActive: false,
					sharerParticipantId: null,
					videoTrack: null,
					audioTrack: null,
				});
				this.events.emit("stopped", { participantId });
			}
		});
	}

	/** Start screen sharing */
	async start(options?: ScreenShareOptions): Promise<boolean> {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		if (this.getState().isActive) {
			// Someone is already sharing
			return false;
		}

		this.setState({ isStarting: true });

		try {
			const result = await this.room.startScreenShare(options);

			if (result && this.room.localParticipant) {
				this.setState({
					isActive: true,
					isStarting: false,
					sharerParticipantId: this.room.localParticipant.id,
					videoTrack: this.room.localParticipant.screenShareTrack ?? null,
					audioTrack: this.room.localParticipant.screenShareAudioTrack ?? null,
				});
				this.events.emit("started", {
					participantId: this.room.localParticipant.id,
					isLocal: true,
				});
			} else {
				this.setState({ isStarting: false });
			}

			return result;
		} catch (err) {
			this.setState({ isStarting: false });
			const error = ChalkError.wrap(err);
			this.events.emit("error", error);
			throw error;
		}
	}

	/** Stop screen sharing */
	async stop(): Promise<void> {
		if (!this.room) {
			throw new ChalkError(
				ChalkErrorCode.NOT_IN_ROOM,
				"Not connected to a room",
			);
		}

		const state = this.getState();
		const localId = this.room.localParticipant?.id;

		// Can only stop own screen share
		if (state.sharerParticipantId !== localId) {
			return;
		}

		await this.room.stopScreenShare();

		this.setState({
			isActive: false,
			sharerParticipantId: null,
			videoTrack: null,
			audioTrack: null,
		});

		if (localId) {
			this.events.emit("stopped", { participantId: localId });
		}
	}

	/** Whether local user is the one sharing */
	get isLocalSharing(): boolean {
		const state = this.getState();
		return (
			state.isActive &&
			state.sharerParticipantId === this.room?.localParticipant?.id
		);
	}

	/** Cleanup resources */
	dispose(): void {
		this.events.removeAllListeners();
	}
}
