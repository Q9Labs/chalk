import { DIRECT_PATH_ATTEMPT_TIMEOUT_MS, DIRECT_PATH_FAILURE_MEMORY_MS, directPathBlocked, markDirectPathFailed, sharedDirectPathMemory, type DirectPathMemory, type TransportPath } from "../direct-path";
import type { SyncClock, SyncSocket, SyncWebSocketFactory } from "./types";

export type { DirectPathMemory };
/** A blocked direct path costs at most this much before the Tunnel socket opens. */
export const DIRECT_SYNC_ATTEMPT_TIMEOUT_MS = DIRECT_PATH_ATTEMPT_TIMEOUT_MS;
/** After a failed direct attempt, later connections skip the direct path for this long. */
export const DIRECT_SYNC_FAILURE_MEMORY_MS = DIRECT_PATH_FAILURE_MEMORY_MS;

type Clock = Pick<SyncClock, "now" | "setTimeout" | "clearTimeout">;

/** The browser clock, shared with the connection dependencies. */
export const defaultClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export type DirectFirstOptions = {
  /** The direct Sync URL; only its scheme and host replace the Tunnel URL's. */
  readonly directUrl: string;
  readonly inner: SyncWebSocketFactory;
  readonly clock?: Clock;
  readonly attemptTimeoutMs?: number;
  readonly failureMemoryMs?: number;
  readonly memory?: DirectPathMemory;
  /** Told which path each connection used: `direct` once the direct socket opens, `tunnel` when the Tunnel carries it. */
  readonly onPath?: (path: TransportPath) => void;
};

/**
 * Opens the direct Sync socket first and falls back to the Tunnel URL when the direct attempt fails
 * before its first server frame (connect error, TLS failure, timeout, a proxy bound). The fallback is
 * invisible to the client: it sees one socket. A failed direct path is skipped for a bounded time.
 */
export function createDirectFirstWebSocketFactory(options: DirectFirstOptions): SyncWebSocketFactory {
  const direct = new URL(options.directUrl);
  const clock = options.clock ?? defaultClock;
  const memory = options.memory ?? sharedDirectPathMemory;
  return {
    connect(tunnelUrl) {
      const attempt = directAttemptUrl(direct, tunnelUrl, memory, clock.now());
      if (!attempt) {
        options.onPath?.({ plane: "sync", path: "tunnel", fellBack: true });
        return options.inner.connect(tunnelUrl);
      }
      const markFailed = () => markDirectPathFailed(memory, direct.host, clock.now(), options.failureMemoryMs ?? DIRECT_SYNC_FAILURE_MEMORY_MS);
      return new DirectFirstSocket(options.inner, attempt, tunnelUrl, clock, options.attemptTimeoutMs ?? DIRECT_SYNC_ATTEMPT_TIMEOUT_MS, markFailed, options.onPath);
    },
  };
}

/** The direct URL a connection dials first, with the Tunnel URL's path and query, or null when it uses the Tunnel straight away. */
function directAttemptUrl(direct: URL, tunnelUrl: string, memory: DirectPathMemory, now: number): string | null {
  const url = new URL(tunnelUrl);
  // The hello frame carries the token, so a secure Tunnel URL never falls to a plain direct one.
  if ((url.protocol === "wss:" && direct.protocol !== "wss:") || directPathBlocked(memory, direct.host, now)) return null;
  url.protocol = direct.protocol;
  // The direct host is its own origin: assigning `host` alone would keep the Tunnel URL's port.
  url.hostname = direct.hostname;
  url.port = direct.port;
  return url.toString();
}

/** The URL a socket opened ahead of `connect` must have to be adopted: what `connect` dials first for this direct URL. */
export function directFirstWarmUrl(directUrl: string | null | undefined, tunnelUrl: string): string {
  return (directUrl ? directAttemptUrl(new URL(directUrl), tunnelUrl, sharedDirectPathMemory, Date.now()) : null) ?? tunnelUrl;
}

/** Spread into the sync client options: empty (today's behaviour) unless a direct URL is configured. */
export function directFirstSyncOptions(directUrl: string | null | undefined, inner: SyncWebSocketFactory, onPath?: (path: TransportPath) => void): { readonly webSocket?: SyncWebSocketFactory } {
  return directUrl ? { webSocket: createDirectFirstWebSocketFactory({ directUrl, inner, ...(onPath ? { onPath } : {}) }) } : {};
}

class DirectFirstSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: SyncSocket["onclose"] = null;
  onerror: (() => void) | null = null;
  #active: SyncSocket | undefined;
  #state: "trying_direct" | "direct" | "tunnel" | "closed" = "trying_direct";
  #frames = false;
  #timer: unknown;

  constructor(
    private readonly inner: SyncWebSocketFactory,
    directUrl: string,
    private readonly tunnelUrl: string,
    private readonly clock: Clock,
    attemptTimeoutMs: number,
    private readonly markFailed: () => void,
    private readonly onPath?: (path: TransportPath) => void,
  ) {
    try {
      this.#active = inner.connect(directUrl);
    } catch {
      // Nobody listens yet: a Tunnel failure here must reach the caller as a constructor error.
      this.markFailed();
      this.#openTunnel();
      return;
    }
    this.#attach(this.#active, "direct");
    this.#timer = clock.setTimeout(() => this.#fallBack(), attemptTimeoutMs);
  }

  send(data: string): void {
    if (!this.#active) throw new Error("Sync socket is not connected");
    this.#active.send(data);
  }

  close(code?: number, reason?: string): void {
    this.#state = "closed";
    this.clock.clearTimeout(this.#timer);
    this.#active?.close(code, reason);
  }

  #attach(socket: SyncSocket, path: "direct" | "tunnel"): void {
    const live = () => this.#active === socket && this.#state !== "closed";
    // An upgrade that never delivers a server frame (a proxy bound, a blocked path, a reset after hello) failed the direct attempt.
    const failedEarly = () => path === "direct" && !this.#frames;
    socket.onopen = () => {
      if (!live()) return;
      this.clock.clearTimeout(this.#timer);
      if (path === "direct") {
        this.#state = "direct";
        this.onPath?.({ plane: "sync", path: "direct", fellBack: false });
      }
      this.onopen?.();
    };
    socket.onmessage = (event) => {
      if (!live()) return;
      this.#frames ||= path === "direct";
      this.onmessage?.(event);
    };
    socket.onerror = () => {
      if (!live()) return;
      if (this.#state === "trying_direct") return this.#fallBack();
      if (failedEarly()) this.markFailed();
      this.onerror?.();
    };
    socket.onclose = (event) => {
      if (this.#active !== socket) return;
      // After close() the client still needs the close event, for example to reconnect after a heartbeat timeout.
      if (this.#state === "trying_direct") return this.#fallBack();
      if (this.#state !== "closed" && failedEarly()) this.markFailed();
      this.onclose?.(event);
    };
  }

  #fallBack(): void {
    this.clock.clearTimeout(this.#timer);
    this.markFailed();
    const abandoned = this.#active;
    try {
      this.#openTunnel();
    } catch {
      this.onerror?.();
      this.onclose?.({ code: 1006, wasClean: false });
    }
    try {
      abandoned?.close();
    } catch {
      // The abandoned socket may already be closed.
    }
  }

  #openTunnel(): void {
    this.onPath?.({ plane: "sync", path: "tunnel", fellBack: true });
    this.#state = "tunnel";
    this.#active = undefined;
    this.#active = this.inner.connect(this.tunnelUrl);
    this.#attach(this.#active, "tunnel");
  }
}
