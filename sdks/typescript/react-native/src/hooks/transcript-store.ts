import type { Transcript } from "../internal/core";
import type { ExternalStore } from "./external-store";

export interface TranscriptRoom {
  readonly transcripts: readonly Transcript[];
  on: (event: "transcript", handler: (transcript: Transcript) => void) => (() => void) | void;
  off: (event: "transcript", handler: (transcript: Transcript) => void) => void;
}

export interface TranscriptSnapshot {
  readonly transcripts: Transcript[];
  readonly isAvailable: boolean;
}

export interface TranscriptStore extends ExternalStore<TranscriptSnapshot> {
  clear: () => void;
  setSource: (room: TranscriptRoom | null, isConnected: boolean) => void;
  subscribeToSource: (listener: () => void, room: TranscriptRoom | null, isConnected: boolean) => () => void;
}

export function createTranscriptStore(): TranscriptStore {
  let snapshot: TranscriptSnapshot = { transcripts: [], isAvailable: false };
  let currentRoom: TranscriptRoom | null = null;
  let isConnected = false;
  let unsubscribeRoom: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    listeners.forEach((listener) => listener());
  };

  const setSource = (room: TranscriptRoom | null, connected: boolean): void => {
    const roomChanged = room !== currentRoom;
    const connectionChanged = connected !== isConnected;
    currentRoom = room;
    isConnected = connected;

    if ((!roomChanged && !connectionChanged) || !room || !connected) return;

    const existing = [...room.transcripts];
    if (existing.length > 0) {
      snapshot = { transcripts: existing, isAvailable: true };
    }
  };

  const subscribeToSource = (listener: () => void, room: TranscriptRoom | null, connected: boolean): (() => void) => {
    setSource(room, connected);
    listeners.add(listener);

    if (listeners.size === 1 && currentRoom && isConnected) {
      const source = currentRoom;
      const handleTranscript = (transcript: Transcript): void => {
        if (source !== currentRoom || !isConnected) return;
        snapshot = {
          transcripts: [...snapshot.transcripts, transcript],
          isAvailable: true,
        };
        notify();
      };
      const cleanup = source.on("transcript", handleTranscript);
      unsubscribeRoom = typeof cleanup === "function" ? cleanup : () => source.off("transcript", handleTranscript);
    }

    return () => {
      listeners.delete(listener);
      if (listeners.size !== 0) return;
      unsubscribeRoom?.();
      unsubscribeRoom = null;
    };
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => subscribeToSource(listener, currentRoom, isConnected),
    subscribeToSource,
    setSource,
    clear: () => {
      snapshot = { ...snapshot, transcripts: [] };
      notify();
    },
  };
}
