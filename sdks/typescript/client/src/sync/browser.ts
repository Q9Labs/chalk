import { SyncBrowserCapabilityError } from "./errors";
import type { SyncLifecycle, SyncSocket, SyncWebSocketFactory } from "./types";

export type BrowserWebSocketConstructor = new (url: string) => WebSocket;

export type BrowserLifecycleEnvironment = {
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly document: Pick<Document, "addEventListener" | "removeEventListener" | "hidden">;
  readonly navigator?: Pick<Navigator, "onLine">;
};

export function createBrowserWebSocketFactory(WebSocketConstructor?: BrowserWebSocketConstructor): SyncWebSocketFactory {
  return {
    connect(url) {
      const Constructor = WebSocketConstructor ?? globalThis.WebSocket;
      if (!Constructor) {
        throw new SyncBrowserCapabilityError("WebSocket");
      }
      return new BrowserSyncSocket(new Constructor(url));
    },
  };
}

export function createBrowserSyncLifecycle(environment = browserLifecycleEnvironment()): SyncLifecycle {
  return {
    subscribe(listener) {
      const online = () => listener("online");
      const offline = () => listener("offline");
      const visibility = () => listener(environment.document.hidden ? "inactive" : "active");
      environment.window.addEventListener("online", online);
      environment.window.addEventListener("offline", offline);
      environment.document.addEventListener("visibilitychange", visibility);
      listener((environment.navigator?.onLine ?? true) ? "online" : "offline");
      visibility();

      return () => {
        environment.window.removeEventListener("online", online);
        environment.window.removeEventListener("offline", offline);
        environment.document.removeEventListener("visibilitychange", visibility);
      };
    },
  };
}

class BrowserSyncSocket implements SyncSocket {
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

function browserLifecycleEnvironment(): BrowserLifecycleEnvironment {
  if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined" || typeof globalThis.navigator === "undefined") {
    throw new SyncBrowserCapabilityError("browser lifecycle");
  }
  return { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
}
