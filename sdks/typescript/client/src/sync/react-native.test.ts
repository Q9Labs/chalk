import { describe, expect, it } from "vitest";
import { SyncPersistenceError } from "./index";
import { AsyncStoragePendingCommandStore, createReactNativeSyncLifecycle, createReactNativeWebSocketFactory } from "./react-native";
import type { PendingCommand } from "./types";

const firstCommand: PendingCommand = {
  commandId: "command-00000001",
  command: { name: "raise_hand" },
  createdAt: 2,
  bytes: 42,
};

const secondCommand: PendingCommand = {
  commandId: "command-00000002",
  command: { name: "lower_hand" },
  createdAt: 1,
  bytes: 42,
};

describe("React Native pending-command storage", () => {
  it("serializes concurrent writes, survives a new store instance, and returns isolated records", async () => {
    const storage = new TestAsyncStorage();
    const store = new AsyncStoragePendingCommandStore({ scope: "session-1", storage });

    await Promise.all([store.put(firstCommand), store.put(secondCommand)]);
    const loaded = await store.load();

    expect(loaded.map((command) => command.commandId)).toEqual([secondCommand.commandId, firstCommand.commandId]);
    (loaded[0] as { commandId: string }).commandId = "mutated-command-id";
    expect((await new AsyncStoragePendingCommandStore({ scope: "session-1", storage }).load()).map((command) => command.commandId)).toEqual([secondCommand.commandId, firstCommand.commandId]);

    await store.remove(firstCommand.commandId);
    await store.remove(secondCommand.commandId);
    expect(storage.values.size).toBe(0);
  });

  it("rejects invalid persisted data without treating it as a new pending queue", async () => {
    const storage = new TestAsyncStorage();
    storage.values.set("chalk-sync-v2:pending-commands:session-1", "not JSON");
    const store = new AsyncStoragePendingCommandStore({ scope: "session-1", storage });

    await expect(store.load()).rejects.toBeInstanceOf(SyncPersistenceError);
  });
});

describe("React Native sync boundaries", () => {
  it("adapts property-based WebSocket callbacks and preserves close codes", () => {
    const socket = createReactNativeWebSocketFactory(TestReactNativeWebSocket).connect("wss://sync.test/v2/sync");
    const events: string[] = [];
    socket.onopen = () => events.push("open");
    socket.onmessage = (event) => events.push(`message:${String(event.data)}`);
    socket.onclose = (event) => events.push(`close:${event.code}`);
    socket.onerror = () => events.push("error");
    const native = TestReactNativeWebSocket.latest();

    native.open();
    native.message("frame");
    native.closeEvent(1012);
    native.error();
    socket.send("outbound");
    socket.close(1000, "done");

    expect(events).toEqual(["open", "message:frame", "close:1012", "error"]);
    expect(native.sent).toEqual(["outbound"]);
    expect(native.closed).toEqual([1000, "done"]);
  });

  it("maps app state and reachability into core lifecycle events and removes both listeners", () => {
    const appState = new TestAppState("background");
    const networkInfo = new TestNetworkInfo();
    const events: string[] = [];
    const unsubscribe = createReactNativeSyncLifecycle({ appState, networkInfo }).subscribe((event) => events.push(event));

    appState.emit("active");
    networkInfo.emit({ isConnected: false, isInternetReachable: false });
    networkInfo.emit({ isConnected: true, isInternetReachable: null });
    unsubscribe();
    appState.emit("inactive");
    networkInfo.emit({ isConnected: false });

    expect(events).toEqual(["inactive", "active", "offline", "online"]);
    expect(appState.removed).toBe(true);
    expect(networkInfo.removed).toBe(true);
  });
});

class TestAsyncStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class TestReactNativeWebSocket {
  static #sockets: TestReactNativeWebSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code?: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed: [number | undefined, string | undefined] | undefined;

  constructor(_: string) {
    TestReactNativeWebSocket.#sockets.push(this);
  }

  static latest(): TestReactNativeWebSocket {
    const socket = TestReactNativeWebSocket.#sockets.at(-1);
    if (!socket) {
      throw new Error("missing test socket");
    }
    return socket;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = [code, reason];
  }

  open(): void {
    this.onopen?.({});
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  closeEvent(code: number): void {
    this.onclose?.({ code });
  }

  error(): void {
    this.onerror?.({});
  }
}

class TestAppState {
  readonly #listeners = new Set<(state: string) => void>();
  removed = false;

  constructor(readonly currentState: string) {}

  addEventListener(_: "change", listener: (state: string) => void): { remove(): void } {
    this.#listeners.add(listener);
    return {
      remove: () => {
        this.removed = true;
        this.#listeners.delete(listener);
      },
    };
  }

  emit(state: string): void {
    for (const listener of this.#listeners) {
      listener(state);
    }
  }
}

class TestNetworkInfo {
  readonly #listeners = new Set<(state: { readonly isConnected: boolean | null; readonly isInternetReachable?: boolean | null }) => void>();
  removed = false;

  addEventListener(listener: (state: { readonly isConnected: boolean | null; readonly isInternetReachable?: boolean | null }) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.removed = true;
      this.#listeners.delete(listener);
    };
  }

  emit(state: { readonly isConnected: boolean | null; readonly isInternetReachable?: boolean | null }): void {
    for (const listener of this.#listeners) {
      listener(state);
    }
  }
}
