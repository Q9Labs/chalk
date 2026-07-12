import { SyncPersistenceError, SyncReactNativeCapabilityError } from "./errors";
import { isPendingCommand } from "./pending-command-validation";
import { comparePendingCommands, copyPendingCommand, type PendingCommandStore } from "./persistence";
import type { PendingCommand, SyncLifecycle, SyncSocket, SyncWebSocketFactory } from "./types";

const STORAGE_PREFIX = "chalk-sync-v2:pending-commands:";

export type ReactNativeAsyncStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type AsyncStoragePendingCommandStoreOptions = {
  readonly scope: string;
  readonly storage: ReactNativeAsyncStorage;
};

export class AsyncStoragePendingCommandStore implements PendingCommandStore {
  readonly #storage: ReactNativeAsyncStorage;
  readonly #key: string;
  #operations = Promise.resolve();

  constructor(options: AsyncStoragePendingCommandStoreOptions) {
    if (options.scope.length === 0) {
      throw new SyncPersistenceError("AsyncStorage pending-command scope must not be empty");
    }
    this.#storage = options.storage;
    this.#key = `${STORAGE_PREFIX}${options.scope}`;
  }

  load(): Promise<readonly PendingCommand[]> {
    return this.#enqueue(async () => (await this.#read()).map(copyPendingCommand).sort(comparePendingCommands));
  }

  put(command: PendingCommand): Promise<void> {
    return this.#enqueue(() => this.#put(command));
  }

  remove(commandId: string): Promise<void> {
    return this.#enqueue(async () => {
      const commands = await this.#read();
      const next = commands.filter((command) => command.commandId !== commandId);
      if (next.length !== commands.length) {
        await this.#write(next);
      }
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #read(): Promise<PendingCommand[]> {
    return parsePendingCommands(await this.#readStoredValue());
  }

  async #readStoredValue(): Promise<string | null> {
    try {
      return await this.#storage.getItem(this.#key);
    } catch {
      throw new SyncPersistenceError("unable to read AsyncStorage pending-command storage");
    }
  }

  async #put(command: PendingCommand): Promise<void> {
    const commands = await this.#read();
    await this.#write(upsertPendingCommand(commands, command));
  }

  async #write(commands: readonly PendingCommand[]): Promise<void> {
    try {
      if (commands.length === 0) {
        await this.#storage.removeItem(this.#key);
        return;
      }
      await this.#storage.setItem(this.#key, JSON.stringify(commands.map(copyPendingCommand)));
    } catch {
      throw new SyncPersistenceError("unable to write AsyncStorage pending-command storage");
    }
  }
}

function parsePendingCommands(stored: string | null): PendingCommand[] {
  if (stored === null) {
    return [];
  }
  const value = parseStoredCommands(stored);
  if (!Array.isArray(value)) {
    throw new SyncPersistenceError("AsyncStorage pending-command storage is invalid");
  }
  return value.filter(isPendingCommand).map(copyPendingCommand);
}

function parseStoredCommands(stored: string): unknown {
  try {
    return JSON.parse(stored);
  } catch {
    throw new SyncPersistenceError("AsyncStorage pending-command storage is invalid");
  }
}

export type ReactNativeWebSocketCloseEvent = {
  readonly code?: unknown;
};

export type ReactNativeWebSocket = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: ReactNativeWebSocketCloseEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type ReactNativeWebSocketConstructor = new (url: string) => ReactNativeWebSocket;

export function createReactNativeWebSocketFactory(WebSocketConstructor?: ReactNativeWebSocketConstructor): SyncWebSocketFactory {
  return {
    connect(url) {
      if (WebSocketConstructor) {
        return new ReactNativeSyncSocket(new WebSocketConstructor(url));
      }
      if (!globalThis.WebSocket) {
        throw new SyncReactNativeCapabilityError("WebSocket");
      }
      return new BrowserFallbackSyncSocket(new globalThis.WebSocket(url));
    },
  };
}

export type ReactNativeEventSubscription = (() => void) | { remove(): void };

export type ReactNativeAppState = {
  readonly currentState: string | null | undefined;
  addEventListener(type: "change", listener: (state: string) => void): ReactNativeEventSubscription;
};

export type ReactNativeNetworkState = {
  readonly isConnected: boolean | null;
  readonly isInternetReachable?: boolean | null;
};

export type ReactNativeNetworkInfo = {
  addEventListener(listener: (state: ReactNativeNetworkState) => void): ReactNativeEventSubscription;
};

export type ReactNativeLifecycleEnvironment = {
  readonly appState: ReactNativeAppState;
  readonly networkInfo?: ReactNativeNetworkInfo;
};

export function createReactNativeSyncLifecycle(environment: ReactNativeLifecycleEnvironment): SyncLifecycle {
  return {
    subscribe(listener) {
      const appState = environment.appState.addEventListener("change", (state) => listener(state === "active" ? "active" : "inactive"));
      const network = environment.networkInfo?.addEventListener((state) => listener(isNetworkOnline(state) ? "online" : "offline"));
      listener(environment.appState.currentState === "active" ? "active" : "inactive");

      return () => {
        unsubscribe(appState);
        if (network) {
          unsubscribe(network);
        }
      };
    },
  };
}

class ReactNativeSyncSocket implements SyncSocket {
  readonly #socket: ReactNativeWebSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(socket: ReactNativeWebSocket) {
    this.#socket = socket;
    this.#socket.onopen = () => this.onopen?.();
    this.#socket.onmessage = (event) => this.onmessage?.({ data: event.data });
    this.#socket.onclose = (event) => this.onclose?.({ code: typeof event.code === "number" ? event.code : 1006 });
    this.#socket.onerror = () => this.onerror?.();
  }

  send(data: string): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }
}

class BrowserFallbackSyncSocket implements SyncSocket {
  readonly #socket: WebSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    this.#socket.addEventListener("open", () => this.onopen?.());
    this.#socket.addEventListener("message", (event) => this.onmessage?.({ data: event.data }));
    this.#socket.addEventListener("close", (event) => this.onclose?.({ code: event.code }));
    this.#socket.addEventListener("error", () => this.onerror?.());
  }

  send(data: string): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }
}

function upsertPendingCommand(commands: readonly PendingCommand[], command: PendingCommand): PendingCommand[] {
  const index = commands.findIndex((stored) => stored.commandId === command.commandId);
  if (index === -1) {
    return [...commands, copyPendingCommand(command)];
  }
  return [...commands.slice(0, index), copyPendingCommand(command), ...commands.slice(index + 1)];
}

function isNetworkOnline(state: ReactNativeNetworkState): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

function unsubscribe(subscription: ReactNativeEventSubscription): void {
  if (typeof subscription === "function") {
    subscription();
  } else {
    subscription.remove();
  }
}
