import type { WhiteboardSnapshot, WhiteboardState, WhiteboardUpdate } from "../internal/core";
import type { ExternalStateManager, ExternalStore } from "./external-store";

interface WhiteboardManager extends ExternalStateManager<WhiteboardState> {
  on: {
    (event: "snapshot", handler: (value: WhiteboardSnapshot) => void): (() => void) | void;
    (event: "update", handler: (value: WhiteboardUpdate) => void): (() => void) | void;
  };
  off: {
    (event: "snapshot", handler: (value: WhiteboardSnapshot) => void): void;
    (event: "update", handler: (value: WhiteboardUpdate) => void): void;
  };
}

export interface WhiteboardHookSnapshot {
  readonly state: WhiteboardState;
  readonly latestUpdate: WhiteboardUpdate | null;
  readonly latestSnapshot: WhiteboardSnapshot | null;
}

export function createWhiteboardStore(whiteboard: WhiteboardManager): ExternalStore<WhiteboardHookSnapshot> {
  let snapshot: WhiteboardHookSnapshot = {
    state: whiteboard.getState(),
    latestUpdate: null,
    latestSnapshot: null,
  };
  const listeners = new Set<() => void>();
  let unsubscribeState: (() => void) | null = null;
  let unsubscribeUpdate: (() => void) | null = null;
  let unsubscribeSnapshot: (() => void) | null = null;

  const notify = (): void => {
    listeners.forEach((listener) => listener());
  };

  const handleUpdate = (update: WhiteboardUpdate): void => {
    snapshot = { ...snapshot, latestUpdate: update };
    notify();
  };

  const handleSnapshot = (latestSnapshot: WhiteboardSnapshot): void => {
    snapshot = { ...snapshot, latestSnapshot };
    notify();
  };

  const subscribeToUpdate = (): (() => void) => {
    const cleanup = whiteboard.on("update", handleUpdate);
    if (typeof cleanup === "function") return cleanup;
    return () => whiteboard.off("update", handleUpdate);
  };

  const subscribeToSnapshot = (): (() => void) => {
    const cleanup = whiteboard.on("snapshot", handleSnapshot);
    if (typeof cleanup === "function") return cleanup;
    return () => whiteboard.off("snapshot", handleSnapshot);
  };

  const start = (): void => {
    snapshot = { ...snapshot, state: whiteboard.getState() };
    unsubscribeState = whiteboard.subscribe((state) => {
      snapshot = { ...snapshot, state };
      notify();
    });
    unsubscribeUpdate = subscribeToUpdate();
    unsubscribeSnapshot = subscribeToSnapshot();
  };

  const stop = (): void => {
    unsubscribeState?.();
    unsubscribeUpdate?.();
    unsubscribeSnapshot?.();
    unsubscribeState = null;
    unsubscribeUpdate = null;
    unsubscribeSnapshot = null;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) start();

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
  };
}
