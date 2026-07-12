import { describe, expect, it } from "vitest";
import type { Transcript } from "../internal/core";
import { createTranscriptStore, type TranscriptRoom } from "./transcript-store";

function createRoom(initialTranscripts: readonly Transcript[] = []): {
  room: TranscriptRoom;
  emit: (transcript: Transcript) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<(transcript: Transcript) => void>();
  const room: TranscriptRoom = {
    transcripts: initialTranscripts,
    on: (_event, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    off: (_event, listener) => {
      listeners.delete(listener);
    },
  };

  return {
    room,
    emit: (transcript) => listeners.forEach((listener) => listener(transcript)),
    listenerCount: () => listeners.size,
  };
}

describe("createTranscriptStore", () => {
  it("loads existing transcripts, tracks events, and detaches on cleanup", () => {
    const initial = { id: "initial", text: "hello" } satisfies Transcript;
    const next = { id: "next", text: "world" } satisfies Transcript;
    const source = createRoom([initial]);
    const store = createTranscriptStore();
    const listener = () => {};

    store.setSource(source.room, true);
    expect(store.getSnapshot()).toEqual({ transcripts: [initial], isAvailable: true });

    const unsubscribe = store.subscribeToSource(listener, source.room, true);
    expect(source.listenerCount()).toBe(1);
    source.emit(next);
    expect(store.getSnapshot()).toEqual({ transcripts: [initial, next], isAvailable: true });

    store.clear();
    expect(store.getSnapshot()).toEqual({ transcripts: [], isAvailable: true });
    unsubscribe();
    expect(source.listenerCount()).toBe(0);
  });

  it("keeps the accumulated snapshot while disconnected", () => {
    const transcript = { id: "initial", text: "hello" } satisfies Transcript;
    const source = createRoom([transcript]);
    const store = createTranscriptStore();

    store.setSource(source.room, true);
    store.setSource(source.room, false);

    expect(store.getSnapshot()).toEqual({ transcripts: [transcript], isAvailable: true });
  });
});
