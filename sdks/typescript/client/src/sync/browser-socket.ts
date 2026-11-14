import type { SyncSocket } from "./types";

const WEBSOCKET_OPEN = 1;

export class BrowserSyncSocket implements SyncSocket {
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
