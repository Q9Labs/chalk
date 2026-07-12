import type { NativeMeetingRoomDiagnosticsSnapshot } from "./diagnostics";
import type { NativeMeetingPanelName } from "./types";

export interface NativeMeetingRoomControllerSnapshot {
  readonly actionsOpen: boolean;
  readonly chatDraft: string;
  readonly localPanel: NativeMeetingPanelName | null;
  readonly reactionPickerOpen: boolean;
  readonly secondsElapsed: number;
}

export interface NativeMeetingRoomControllerStoreSync {
  readonly panel: NativeMeetingPanelName | null;
  readonly markChatAsRead: () => void;
  readonly diagnostics: NativeMeetingRoomDiagnosticsSnapshot;
  readonly onDiagnosticsChange: ((snapshot: NativeMeetingRoomDiagnosticsSnapshot) => void) | undefined;
}

export class NativeMeetingRoomControllerStore {
  #snapshot: NativeMeetingRoomControllerSnapshot = {
    actionsOpen: false,
    chatDraft: "",
    localPanel: null,
    reactionPickerOpen: false,
    secondsElapsed: 0,
  };
  #listeners = new Set<() => void>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #panel: NativeMeetingPanelName | null = null;
  #markChatAsRead: (() => void) | undefined;
  #lastMarkedPanel: NativeMeetingPanelName | null = null;
  #lastMarkChatAsRead: (() => void) | undefined;
  #diagnostics: NativeMeetingRoomDiagnosticsSnapshot | undefined;
  #onDiagnosticsChange: ((snapshot: NativeMeetingRoomDiagnosticsSnapshot) => void) | undefined;
  #lastDiagnosticsSignature: string | null = null;
  #effectsScheduled = false;

  readonly getSnapshot = (): NativeMeetingRoomControllerSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#startTimer();
    this.#runEffects();

    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#timer !== undefined) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
    };
  };

  readonly setActionsOpen = (open: boolean): void => {
    this.#update({ actionsOpen: open });
  };

  readonly setReactionPickerOpen = (open: boolean): void => {
    this.#update({ reactionPickerOpen: open });
  };

  readonly setChatDraft = (value: string): void => {
    this.#update({ chatDraft: value });
  };

  readonly setLocalPanel = (panel: NativeMeetingPanelName | null): void => {
    this.#update({ localPanel: panel });
  };

  readonly sync = ({ panel, markChatAsRead, diagnostics, onDiagnosticsChange }: NativeMeetingRoomControllerStoreSync): void => {
    this.#panel = panel;
    this.#markChatAsRead = markChatAsRead;
    this.#diagnostics = diagnostics;
    this.#onDiagnosticsChange = onDiagnosticsChange;
    if (this.#listeners.size > 0) {
      this.#scheduleEffects();
    }
  };

  #startTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      this.#update({ secondsElapsed: this.#snapshot.secondsElapsed + 1 });
    }, 1000);
  }

  #update(next: Partial<NativeMeetingRoomControllerSnapshot>): void {
    const snapshot = { ...this.#snapshot, ...next };
    if (snapshot.actionsOpen === this.#snapshot.actionsOpen && snapshot.chatDraft === this.#snapshot.chatDraft && snapshot.localPanel === this.#snapshot.localPanel && snapshot.reactionPickerOpen === this.#snapshot.reactionPickerOpen && snapshot.secondsElapsed === this.#snapshot.secondsElapsed) {
      return;
    }

    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  #scheduleEffects(): void {
    if (this.#effectsScheduled) return;
    this.#effectsScheduled = true;
    queueMicrotask(() => {
      this.#effectsScheduled = false;
      if (this.#listeners.size === 0) return;
      this.#runEffects();
    });
  }

  #runEffects(): void {
    if (this.#panel === "chat") {
      if (this.#lastMarkedPanel !== "chat" || this.#lastMarkChatAsRead !== this.#markChatAsRead) {
        this.#lastMarkedPanel = "chat";
        this.#lastMarkChatAsRead = this.#markChatAsRead;
        this.#markChatAsRead?.();
      }
    } else {
      this.#lastMarkedPanel = null;
      this.#lastMarkChatAsRead = undefined;
    }

    const diagnostics = this.#diagnostics;
    const onDiagnosticsChange = this.#onDiagnosticsChange;
    if (!diagnostics || !onDiagnosticsChange) return;

    const signature = JSON.stringify(diagnostics);
    if (signature === this.#lastDiagnosticsSignature) return;

    this.#lastDiagnosticsSignature = signature;
    onDiagnosticsChange(diagnostics);
  }
}
