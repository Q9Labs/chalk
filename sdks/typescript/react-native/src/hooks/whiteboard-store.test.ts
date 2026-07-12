import { describe, expect, it } from "vitest";
import type { WhiteboardSnapshot, WhiteboardState, WhiteboardUpdate } from "../internal/core";
import { createWhiteboardStore } from "./whiteboard-store";

class FakeWhiteboard {
  #state: WhiteboardState = {
    isOpen: false,
    cursors: [],
    openParticipants: [],
    canDraw: false,
    elements: [],
    lastSeq: 0,
  };
  #stateListeners = new Set<(state: WhiteboardState) => void>();
  #updateListeners = new Set<(update: WhiteboardUpdate & WhiteboardSnapshot) => void>();
  #snapshotListeners = new Set<(snapshot: WhiteboardUpdate & WhiteboardSnapshot) => void>();

  getState = (): WhiteboardState => this.#state;

  subscribe = (listener: (state: WhiteboardState) => void): (() => void) => {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  };

  on(event: "update", handler: (value: WhiteboardUpdate) => void): () => void;
  on(event: "snapshot", handler: (value: WhiteboardSnapshot) => void): () => void;
  on(event: "update" | "snapshot", handler: (value: WhiteboardUpdate & WhiteboardSnapshot) => void): () => void {
    const listeners = event === "update" ? this.#updateListeners : this.#snapshotListeners;
    listeners.add(handler);
    return () => listeners.delete(handler);
  }

  off(event: "update", handler: (value: WhiteboardUpdate) => void): void;
  off(event: "snapshot", handler: (value: WhiteboardSnapshot) => void): void;
  off(event: "update" | "snapshot", handler: (value: WhiteboardUpdate & WhiteboardSnapshot) => void): void {
    const listeners = event === "update" ? this.#updateListeners : this.#snapshotListeners;
    listeners.delete(handler);
  }

  emitState(state: WhiteboardState): void {
    this.#state = state;
    this.#stateListeners.forEach((listener) => listener(state));
  }

  emitUpdate(update: WhiteboardUpdate): void {
    this.#updateListeners.forEach((listener) => listener(update));
  }

  emitSnapshot(snapshot: WhiteboardSnapshot): void {
    this.#snapshotListeners.forEach((listener) => listener(snapshot));
  }
}

describe("createWhiteboardStore", () => {
  it("combines manager state and event snapshots and cleans up listeners", () => {
    const whiteboard = new FakeWhiteboard();
    const store = createWhiteboardStore(whiteboard);
    const listener = () => {};
    const unsubscribe = store.subscribe(listener);
    const update = { id: "update-1" } satisfies WhiteboardUpdate;
    const snapshot = { id: "snapshot-1" } satisfies WhiteboardSnapshot;
    const state = { ...whiteboard.getState(), isOpen: true };

    whiteboard.emitState(state);
    whiteboard.emitUpdate(update);
    whiteboard.emitSnapshot(snapshot);

    expect(store.getSnapshot()).toEqual({ state, latestUpdate: update, latestSnapshot: snapshot });
    unsubscribe();
    whiteboard.emitUpdate({ id: "ignored" });
    expect(store.getSnapshot().latestUpdate).toBe(update);
  });
});
