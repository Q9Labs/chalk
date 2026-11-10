import { SyncBrowserCapabilityError } from "./errors";
import type { SyncLifecycle, SyncSocket, SyncWebSocketFactory } from "./types";
import { WarmSocketSlot } from "./warm-socket";

export type BrowserWebSocketConstructor = new (url: string) => WebSocket;

export type BrowserLifecycleEnvironment = {
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly navigator?: Pick<Navigator, "onLine">;
};

const WEBSOCKET_OPEN = 1;
const warmSlot = new WarmSocketSlot({
  open: (url) => (globalThis.WebSocket ? new globalThis.WebSocket(url) : undefined),
  visible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
});

/**
 * Has a Sync socket for `url` upgrading or open before the join, so the first client that dials the same URL adopts it
 * instead of paying the upgrade. See `WarmSocketSlot` for the states and the bounds. Best effort: a socket that cannot open is
 * dropped, and `connect` then dials as usual and reports the real failure.
 */
export function warmBrowserSyncSocket(url: string, keepMs?: number): void {
  warmSlot.warm(url, keepMs);
}

/** Closes the warm socket, if any, and stops keeping one: call it at sign-out. */
export function releaseWarmBrowserSyncSocket(): void {
  warmSlot.release();
}

export function createBrowserWebSocketFactory(WebSocketConstructor?: BrowserWebSocketConstructor): SyncWebSocketFactory {
  return {
    connect(url) {
      const Constructor = WebSocketConstructor ?? globalThis.WebSocket;
      if (!Constructor) {
        throw new SyncBrowserCapabilityError("WebSocket");
      }
      const parked = WebSocketConstructor ? undefined : warmSlot.adopt(url);
      return new BrowserSyncSocket(parked ?? new Constructor(url));
    },
  };
}

export function createBrowserSyncLifecycle(environment = browserLifecycleEnvironment()): SyncLifecycle {
  return {
    subscribe(listener) {
      const online = () => listener("online");
      const offline = () => listener("offline");
      environment.window.addEventListener("online", online);
      environment.window.addEventListener("offline", offline);
      listener((environment.navigator?.onLine ?? true) ? "online" : "offline");

      return () => {
        environment.window.removeEventListener("online", online);
        environment.window.removeEventListener("offline", offline);
      };
    },
  };
}

class BrowserSyncSocket implements SyncSocket {
  readonly #socket: WebSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: SyncSocket["onclose"] = null;
  onerror: (() => void) | null = null;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    this.#socket.addEventListener("open", () => this.onopen?.());
    this.#socket.addEventListener("message", (event) => this.onmessage?.({ data: event.data }));
    this.#socket.addEventListener("close", (event) => this.onclose?.({ code: event.code, reason: event.reason, ...(typeof event.wasClean === "boolean" ? { wasClean: event.wasClean } : {}) }));
    this.#socket.addEventListener("error", () => this.onerror?.());
    // A parked socket opened before this one adopted it, so its open event is already past.
    if (this.#socket.readyState === WEBSOCKET_OPEN) queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.#socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }
}

function browserLifecycleEnvironment(): BrowserLifecycleEnvironment {
  if (typeof globalThis.window === "undefined" || typeof globalThis.navigator === "undefined") {
    throw new SyncBrowserCapabilityError("browser lifecycle");
  }
  return { window: globalThis.window, navigator: globalThis.navigator };
}
