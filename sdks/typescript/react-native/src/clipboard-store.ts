import type { NativeClipboardReader } from "./clipboard";

export interface ClipboardAppStateSubscription {
  remove(): void;
}

export interface ClipboardTextStoreOptions {
  clipboard: NativeClipboardReader;
  shouldReadClipboard: boolean;
  subscribeToAppState(listener: (nextState: string) => void): ClipboardAppStateSubscription;
}

export interface ClipboardTextStore {
  readonly clipboard: NativeClipboardReader;
  readonly shouldReadClipboard: boolean;
  getSnapshot(): string | null;
  subscribe(listener: () => void): () => void;
}

export function createClipboardTextStore({ clipboard, shouldReadClipboard, subscribeToAppState }: ClipboardTextStoreOptions): ClipboardTextStore {
  let snapshot: string | null = null;
  let active = false;
  let requestId = 0;
  let appStateSubscription: ClipboardAppStateSubscription | null = null;
  const listeners = new Set<() => void>();

  const publish = (nextSnapshot: string | null, request: number) => {
    if (!active || request !== requestId || nextSnapshot === snapshot) {
      return;
    }

    snapshot = nextSnapshot;
    for (const listener of listeners) {
      listener();
    }
  };

  const refresh = async () => {
    if (!active) {
      return;
    }

    const request = ++requestId;
    if (!shouldReadClipboard) {
      publish(null, request);
      return;
    }

    try {
      const hasString = await clipboard.hasStringAsync();
      if (!hasString) {
        publish(null, request);
        return;
      }

      const nextClipboardText = await clipboard.getStringAsync();
      publish(nextClipboardText || null, request);
    } catch {
      publish(null, request);
    }
  };

  const start = () => {
    if (active) {
      return;
    }

    active = true;
    void refresh();
    if (shouldReadClipboard) {
      appStateSubscription = subscribeToAppState((nextState) => {
        if (nextState === "active") {
          void refresh();
        }
      });
    }
  };

  const stop = () => {
    if (!active) {
      return;
    }

    active = false;
    requestId += 1;
    appStateSubscription?.remove();
    appStateSubscription = null;
  };

  return {
    clipboard,
    shouldReadClipboard,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        start();
      }

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
        }
      };
    },
  };
}
