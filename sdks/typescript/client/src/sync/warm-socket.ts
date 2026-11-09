// Sync closes a socket that sends no hello within 5 s, so a warm socket gives up first.
export const WARM_SOCKET_TTL_MS = 4000;
/** The longest a warm socket is kept ready after the last call to `warm`: about four sockets of 4 s each. */
export const MAX_KEEP_WARM_MS = 16_000;
const WEBSOCKET_OPEN = 1;

type Timer = ReturnType<typeof setTimeout>;

type Slot = { readonly state: "empty" } | { readonly state: "upgrading" | "ready"; readonly url: string; readonly socket: WebSocket; readonly expire: Timer };

export type WarmSocketHost = {
  /** Starts an upgrade, or returns undefined when the page cannot open a WebSocket. */
  readonly open: (url: string) => WebSocket | undefined;
  readonly visible: () => boolean;
};

/**
 * Owns the one Sync socket a tab keeps open before any hello. A Sync socket serves one hello and one Episode, and Sync closes
 * it when the participant leaves, so a socket cannot carry several calls. This slot instead has the next call's socket
 * upgraded and waiting, which takes the Cloudflare upgrade off the join path.
 *
 *   empty --warm--> upgrading --open--> ready --adopt--> empty (the client owns the socket)
 *   upgrading | ready --close, error--> empty (the keep window ends: a failure never loops)
 *   upgrading | ready --4 s unused--> closed, then upgrading again while the keep window lasts and the tab is visible
 *   any --release--> empty
 *
 * The socket carries no credential and sends nothing, so it needs no grant and holds no seat. It is not tied to a Space or an
 * Episode, so one slot serves every Space page in the tab. A socket that is upgrading or open is healthy by definition: `warm`
 * never replaces it, and only a socket that closed, errored or aged out leaves the slot.
 */
export class WarmSocketSlot {
  readonly #host: WarmSocketHost;
  #slot: Slot = { state: "empty" };
  #keepUntil = 0;

  constructor(host: WarmSocketHost) {
    this.#host = host;
  }

  get state(): Slot["state"] {
    return this.#slot.state;
  }

  /** Makes sure a socket for `url` is upgrading or open. `keepMs` also re-opens it as it ages out, up to `MAX_KEEP_WARM_MS`. */
  warm(url: string, keepMs = 0): void {
    this.#keepUntil = Math.max(this.#keepUntil, Date.now() + Math.min(Math.max(keepMs, 0), MAX_KEEP_WARM_MS));
    const slot = this.#slot;
    if (slot.state !== "empty") {
      if (slot.url === url && slot.socket.readyState <= WEBSOCKET_OPEN) return;
      this.#drop();
    }
    this.#open(url);
  }

  /** Hands the socket for `url` to the Sync client that dials it. The client owns it from here, and the keep window ends. */
  adopt(url: string): WebSocket | undefined {
    const slot = this.#slot;
    if (slot.state === "empty" || slot.url !== url) return undefined;
    clearTimeout(slot.expire);
    this.#slot = { state: "empty" };
    this.#keepUntil = 0;
    return slot.socket.readyState <= WEBSOCKET_OPEN ? slot.socket : undefined;
  }

  /** Closes the socket and ends the keep window: for sign-out and for a tab that goes away. */
  release(): void {
    this.#keepUntil = 0;
    this.#drop();
  }

  #open(url: string): void {
    let socket: WebSocket | undefined;
    try {
      socket = this.#host.open(url);
    } catch {
      socket = undefined;
    }
    if (!socket) {
      this.#keepUntil = 0;
      return;
    }
    const opened = socket;
    const expire = setTimeout(() => this.#age(opened, url), WARM_SOCKET_TTL_MS);
    this.#slot = { state: "upgrading", url, socket: opened, expire };
    opened.addEventListener("open", () => {
      const slot = this.#slot;
      if (slot.state === "upgrading" && slot.socket === opened) this.#slot = { ...slot, state: "ready" };
    });
    const failed = () => {
      const slot = this.#slot;
      if (slot.state === "empty" || slot.socket !== opened) return;
      clearTimeout(slot.expire);
      this.#slot = { state: "empty" };
      this.#keepUntil = 0;
    };
    opened.addEventListener("close", failed);
    opened.addEventListener("error", failed);
  }

  #age(socket: WebSocket, url: string): void {
    const slot = this.#slot;
    if (slot.state === "empty" || slot.socket !== socket) return;
    this.#drop();
    if (Date.now() < this.#keepUntil && this.#host.visible()) this.#open(url);
  }

  #drop(): void {
    const slot = this.#slot;
    if (slot.state === "empty") return;
    this.#slot = { state: "empty" };
    clearTimeout(slot.expire);
    slot.socket.close(1000, "unused");
  }
}
