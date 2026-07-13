import { SyncReactNativeCapabilityError } from "./errors";
import type { SyncLifecycle, SyncSocket, SyncWebSocketFactory } from "./types";

export type ReactNativeAsyncStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

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
