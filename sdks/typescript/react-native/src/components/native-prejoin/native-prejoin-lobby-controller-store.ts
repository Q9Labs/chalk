export interface NativePreJoinLobbyControllerSnapshot {
  readonly displayName: string;
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
  readonly isSubmitting: boolean;
  readonly isInputFocused: boolean;
}

export interface NativePreJoinLobbyControllerStoreOptions {
  readonly displayName: string;
  readonly initialAudioEnabled: boolean;
  readonly initialVideoEnabled: boolean;
  readonly simulatorMediaDisabled: boolean;
  readonly joinDisabled: boolean;
  readonly onJoin: (settings: NativeJoinSettings) => void;
}

export interface NativePreJoinLobbyControllerStoreUpdate {
  readonly simulatorMediaDisabled: boolean;
  readonly joinDisabled: boolean;
  readonly onJoin: (settings: NativeJoinSettings) => void;
}

export class NativePreJoinLobbyControllerStore {
  #snapshot: NativePreJoinLobbyControllerSnapshot;
  #listeners = new Set<() => void>();
  #simulatorMediaDisabled: boolean;
  #joinDisabled: boolean;
  #submitLatch = false;
  #onJoin: NativePreJoinLobbyControllerStoreOptions["onJoin"];

  constructor({ displayName, initialAudioEnabled, initialVideoEnabled, simulatorMediaDisabled, joinDisabled, onJoin }: NativePreJoinLobbyControllerStoreOptions) {
    this.#simulatorMediaDisabled = simulatorMediaDisabled;
    this.#joinDisabled = joinDisabled;
    this.#onJoin = onJoin;
    this.#snapshot = {
      displayName,
      audioEnabled: initialAudioEnabled && !simulatorMediaDisabled,
      videoEnabled: initialVideoEnabled && !simulatorMediaDisabled,
      isSubmitting: false,
      isInputFocused: false,
    };
  }

  readonly getSnapshot = (): NativePreJoinLobbyControllerSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly update = ({ simulatorMediaDisabled, joinDisabled, onJoin }: NativePreJoinLobbyControllerStoreUpdate): void => {
    this.#onJoin = onJoin;

    if (!this.#simulatorMediaDisabled && simulatorMediaDisabled) {
      this.#update({ audioEnabled: false, videoEnabled: false });
    }

    if (this.#joinDisabled && !joinDisabled) {
      this.#submitLatch = false;
      this.#update({ isSubmitting: false });
    }

    this.#simulatorMediaDisabled = simulatorMediaDisabled;
    this.#joinDisabled = joinDisabled;
  };

  readonly setDisplayName = (displayName: string): void => {
    this.#update({ displayName });
  };

  readonly setInputFocused = (isInputFocused: boolean): void => {
    this.#update({ isInputFocused });
  };

  readonly toggleAudio = (): void => {
    if (this.#simulatorMediaDisabled) return;
    this.#update({ audioEnabled: !this.#snapshot.audioEnabled });
  };

  readonly toggleVideo = (): void => {
    if (this.#simulatorMediaDisabled) return;
    this.#update({ videoEnabled: !this.#snapshot.videoEnabled });
  };

  readonly handleJoin = (): void => {
    if (this.#joinDisabled || this.#snapshot.isSubmitting || this.#submitLatch) return;

    this.#submitLatch = true;
    this.#update({ isSubmitting: true });
    this.#onJoin({
      displayName: this.#snapshot.displayName,
      audioEnabled: this.#snapshot.audioEnabled,
      videoEnabled: this.#snapshot.videoEnabled,
    });
  };

  #update(next: Partial<NativePreJoinLobbyControllerSnapshot>): void {
    const snapshot = { ...this.#snapshot, ...next };
    if (snapshot.displayName === this.#snapshot.displayName && snapshot.audioEnabled === this.#snapshot.audioEnabled && snapshot.videoEnabled === this.#snapshot.videoEnabled && snapshot.isSubmitting === this.#snapshot.isSubmitting && snapshot.isInputFocused === this.#snapshot.isInputFocused) {
      return;
    }

    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
import type { NativeJoinSettings } from "../NativePreJoinLobby";
