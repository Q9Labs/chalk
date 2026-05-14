/**
 * Screen share manager for Chalk SDK
 *
 * @packageDocumentation
 * @module @q9labs/chalk-core/managers
 */

import { ChalkError, ChalkErrorCode } from "../errors/chalk-error";
import type { ConferenceSession } from "../room";
import { StateContainer } from "../state/state-container";
import type { ScreenShareOptions } from "../types/entities/media";
import { TypedEventEmitter } from "../utils/typed-emitter";

const isDevRuntime = () => (globalThis as { __DEV__?: boolean }).__DEV__ === true;

/** Screen share manager state */
export interface ScreenShareState {
  /** Whether screen share is active */
  readonly isActive: boolean;
  /** Whether screen share is starting */
  readonly isStarting: boolean;
  /** Whether the current sharer is the local participant */
  readonly isLocalSharer: boolean;
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
  private room: ConferenceSession | null = null;
  private roomUnsubscribers: Array<() => void> = [];

  private hasUsableScreenShareTrack(videoTrack: MediaStreamTrack | null | undefined): videoTrack is MediaStreamTrack {
    return Boolean(videoTrack && videoTrack.readyState === "live" && videoTrack.enabled);
  }

  constructor(_debug = false) {
    super({
      isActive: false,
      isStarting: false,
      isLocalSharer: false,
      sharerParticipantId: null,
      videoTrack: null,
      audioTrack: null,
    });
  }

  /** Subscribe to screen share events */
  on<K extends keyof ScreenShareManagerEvents>(event: K, handler: (data: ScreenShareManagerEvents[K]) => void): () => void {
    return this.events.on(event, handler);
  }

  /** Attach ConferenceSession instance */
  attachRoom(room: ConferenceSession): void {
    this.teardownRoomListeners();
    this.room = room;
    this.setupRoomListeners();
    this.syncFromRoom();
  }

  private teardownRoomListeners(): void {
    for (const unsubscribe of this.roomUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // best effort cleanup
      }
    }
    this.roomUnsubscribers = [];
  }

  private resetShareState(extraState?: Partial<ScreenShareState>): void {
    this.setState({
      isActive: false,
      isStarting: false,
      isLocalSharer: false,
      sharerParticipantId: null,
      videoTrack: null,
      audioTrack: null,
      ...extraState,
    });
  }

  private syncFromRoom(): void {
    if (!this.room) return;

    // Check if local user is screen sharing
    const localParticipant = this.room.localParticipant;
    if (localParticipant?.isScreenSharing && this.hasUsableScreenShareTrack(localParticipant.screenShareTrack)) {
      this.setState({
        isActive: true,
        isStarting: false,
        isLocalSharer: true,
        sharerParticipantId: localParticipant.id,
        videoTrack: localParticipant.screenShareTrack ?? null,
        audioTrack: localParticipant.screenShareAudioTrack ?? null,
      });
      return;
    }

    // Check if any remote participant is screen sharing
    for (const [, participant] of this.room.participants) {
      if (participant.isScreenSharing && this.hasUsableScreenShareTrack(participant.screenShareTrack)) {
        this.setState({
          isActive: true,
          isStarting: false,
          isLocalSharer: false,
          sharerParticipantId: participant.id,
          videoTrack: participant.screenShareTrack ?? null,
          audioTrack: participant.screenShareAudioTrack ?? null,
        });
        return;
      }
    }

    this.resetShareState();
  }

  private setupRoomListeners(): void {
    if (!this.room) return;

    this.roomUnsubscribers.push(
      this.room.on("participant.updated", ({ participantId, participant }) => {
        const wasSharing = this.getState().sharerParticipantId === participantId;
        const isNowSharing = participant.isScreenSharing;
        const hasUsableTrack = this.hasUsableScreenShareTrack(participant.screenShareTrack);

        if (!wasSharing && isNowSharing && hasUsableTrack) {
          // Started sharing
          const isLocal = participant.isLocal;
          this.setState({
            isActive: true,
            isStarting: false,
            isLocalSharer: isLocal,
            sharerParticipantId: participantId,
            videoTrack: participant.screenShareTrack ?? null,
            audioTrack: participant.screenShareAudioTrack ?? null,
          });
          this.events.emit("started", { participantId, isLocal });
        } else if (wasSharing && (!isNowSharing || !hasUsableTrack)) {
          // Stopped sharing
          this.resetShareState();
          this.events.emit("stopped", { participantId });
        } else if (wasSharing && isNowSharing && hasUsableTrack) {
          // Update tracks
          this.setState({
            videoTrack: participant.screenShareTrack ?? null,
            audioTrack: participant.screenShareAudioTrack ?? null,
          });
        }
      }),
    );

    this.roomUnsubscribers.push(
      this.room.on("participant.left", (participantId) => {
        if (this.getState().sharerParticipantId === participantId) {
          this.resetShareState();
          this.events.emit("stopped", { participantId });
        }
      }),
    );
  }

  /** Start screen sharing */
  async start(options?: ScreenShareOptions): Promise<boolean> {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    if (this.getState().isActive) {
      // Someone is already sharing
      return false;
    }

    if (isDevRuntime()) {
      console.info("[chalk][screenshare-manager] start:request", {
        options: options ?? null,
        stateBefore: this.getState(),
      });
    }

    this.setState({ isStarting: true });

    try {
      const result = await this.room.startScreenShare(options);

      if (!result) {
        if (isDevRuntime()) {
          console.warn("[chalk][screenshare-manager] start:rejected", {
            options: options ?? null,
            stateBeforeReset: this.getState(),
          });
        }
        this.resetShareState();
        // ConferenceSession.startScreenShare already emits the room-level error.
        // Avoid a second generic manager error that would hide the original cause.
        return result;
      }

      const previousState = this.getState();
      this.syncFromRoom();

      const nextState = this.getState();
      if (!previousState.isActive && nextState.isActive && nextState.sharerParticipantId) {
        this.events.emit("started", {
          participantId: nextState.sharerParticipantId,
          isLocal: nextState.isLocalSharer,
        });
      }

      if (isDevRuntime() && result && !nextState.isActive) {
        console.warn("[chalk][screenshare-manager] start:no-active-share-state", {
          result,
          previousState,
          nextState,
        });
      }

      if (isDevRuntime()) {
        console.info("[chalk][screenshare-manager] start:result", {
          result,
          previousState,
          nextState,
        });
      }

      return result;
    } catch (err) {
      this.resetShareState();
      const error = ChalkError.wrap(err);

      if (isDevRuntime()) {
        console.warn("[chalk][screenshare-manager] start:error", {
          options: options ?? null,
          errorCode: error.code,
          errorMessage: error.message,
        });
      }

      this.events.emit("error", error);
      throw error;
    }
  }

  /** Stop screen sharing */
  async stop(): Promise<void> {
    if (!this.room) {
      throw new ChalkError(ChalkErrorCode.NOT_IN_ROOM, "Not connected to a room");
    }

    const state = this.getState();
    // Can only stop own screen share. Prefer local/remote marker rather than
    // comparing ids, since stable participant ids can change during a session.
    if (!state.isLocalSharer) {
      return;
    }

    await this.room.stopScreenShare();

    this.resetShareState();

    if (state.sharerParticipantId) {
      this.events.emit("stopped", { participantId: state.sharerParticipantId });
    }
  }

  /** Whether local user is the one sharing */
  get isLocalSharing(): boolean {
    const state = this.getState();
    return state.isActive && state.isLocalSharer;
  }

  /** Cleanup resources */
  dispose(): void {
    this.teardownRoomListeners();
    this.room = null;
    this.events.removeAllListeners();
  }
}
