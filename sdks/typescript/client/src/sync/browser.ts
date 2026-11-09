import { SyncBrowserCapabilityError } from "./errors";
import type { SyncLifecycle, SyncSocket, SyncWebSocketFactory } from "./types";

export type BrowserWebSocketConstructor = new (url: string) => WebSocket;

export type BrowserLifecycleEnvironment = {
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly navigator?: Pick<Navigator, "onLine">;
};

const WEBSOCKET_OPEN = 1;
// Sync closes a socket that sends no hello within 5 s, so a parked socket gives up first.
const PARKED_SOCKET_TTL_MS = 4000;
const parkedSockets = new Map<string, { readonly socket: WebSocket; readonly expire: ReturnType<typeof setTimeout> }>();

/**
 * Opens a Sync socket ahead of the join so the upgrade finishes before the client dials. The default factory hands it to
 * the first `connect` for the same URL. The socket carries no credential and sends nothing: the token goes in the hello.
 * Best effort: a socket that cannot open is dropped, and `connect` then dials as usual and reports the real failure.
 */
export function parkBrowserSyncSocket(url: string): void {
  if (parkedSockets.has(url) || !globalThis.WebSocket) return;
  let socket: WebSocket;
  try {
    socket = new globalThis.WebSocket(url);
  } catch {
    return;
  }
  const release = () => {
    if (parkedSockets.get(url)?.socket === socket) parkedSockets.delete(url);
  };
  const expire = setTimeout(() => {
    release();
    socket.close(1000, "unused");
  }, PARKED_SOCKET_TTL_MS);
  parkedSockets.set(url, { socket, expire });
  socket.addEventListener("close", release);
  socket.addEventListener("error", release);
}

function takeParkedSocket(url: string): WebSocket | undefined {
  const parked = parkedSockets.get(url);
  if (!parked) return undefined;
  parkedSockets.delete(url);
  clearTimeout(parked.expire);
  return parked.socket.readyState <= WEBSOCKET_OPEN ? parked.socket : undefined;
}

export function createBrowserWebSocketFactory(WebSocketConstructor?: BrowserWebSocketConstructor): SyncWebSocketFactory {
  return {
    connect(url) {
      const Constructor = WebSocketConstructor ?? globalThis.WebSocket;
      if (!Constructor) {
        throw new SyncBrowserCapabilityError("WebSocket");
      }
      const parked = WebSocketConstructor ? undefined : takeParkedSocket(url);
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
