import type { SyncClock, SyncSocket, SyncWebSocketFactory } from "./types";

/** A blocked direct path costs at most this much before the Tunnel socket opens. */
export const DIRECT_SYNC_ATTEMPT_TIMEOUT_MS = 2_500;
/** After a failed direct attempt, later connections skip the direct path for this long. */
export const DIRECT_SYNC_FAILURE_MEMORY_MS = 10 * 60_000;
/** The direct proxy closes with this code when it is over a connection bound. */
const TRY_AGAIN_LATER = 1013;
const MAX_REMEMBERED_HOSTS = 8;

/** Remembers which direct hosts failed, so a blocked path is not retried on every reconnect. */
export type DirectPathMemory = {
  readonly isFailed: (host: string, now: number) => boolean;
  readonly markFailed: (host: string, until: number) => void;
};

export function createDirectPathMemory(): DirectPathMemory {
  const failedUntil = new Map<string, number>();
  return {
    isFailed: (host, now) => (failedUntil.get(host) ?? 0) > now,
    markFailed: (host, until) => {
      failedUntil.delete(host);
      failedUntil.set(host, until);
      for (const oldest of failedUntil.keys()) {
        if (failedUntil.size <= MAX_REMEMBERED_HOSTS) break;
        failedUntil.delete(oldest);
      }
    },
  };
}

// Shared by every client in the page, so a new Episode does not rediscover a blocked path.
const sharedMemory = createDirectPathMemory();

export type DirectFirstOptions = {
  /** The direct Sync URL; only its scheme and host replace the Tunnel URL's. */
  readonly directUrl: string;
  readonly inner: SyncWebSocketFactory;
  readonly clock?: Pick<SyncClock, "now" | "setTimeout" | "clearTimeout">;
  readonly attemptTimeoutMs?: number;
  readonly failureMemoryMs?: number;
  readonly memory?: DirectPathMemory;
};

/**
 * Opens the direct Sync socket first and falls back to the Tunnel URL when the direct
 * attempt fails before it opens (connect error, TLS failure, timeout) or when the direct
 * proxy turns the client away. The fallback is invisible to the client: it sees one socket.
 */
export function createDirectFirstWebSocketFactory(options: DirectFirstOptions): SyncWebSocketFactory {
  const directHost = new URL(options.directUrl).host;
  const clock = options.clock ?? defaultClock;
  const memory = options.memory ?? sharedMemory;
  const settings = {
    attemptTimeoutMs: options.attemptTimeoutMs ?? DIRECT_SYNC_ATTEMPT_TIMEOUT_MS,
    failureMemoryMs: options.failureMemoryMs ?? DIRECT_SYNC_FAILURE_MEMORY_MS,
  };
  return {
    connect(tunnelUrl) {
      if (memory.isFailed(directHost, clock.now())) return options.inner.connect(tunnelUrl);
      const markFailed = () => memory.markFailed(directHost, clock.now() + settings.failureMemoryMs);
      return new DirectFirstSocket(options.inner, directUrlFor(tunnelUrl, options.directUrl), tunnelUrl, clock, settings.attemptTimeoutMs, markFailed);
    },
  };
}

/** Spread into the sync client options: empty (today's behaviour) unless a direct URL is configured. */
export function directFirstSyncOptions(directUrl: string | null | undefined, inner: SyncWebSocketFactory): { readonly webSocket?: SyncWebSocketFactory } {
  return directUrl ? { webSocket: createDirectFirstWebSocketFactory({ directUrl, inner }) } : {};
}

function directUrlFor(tunnelUrl: string, directUrl: string): string {
  const url = new URL(tunnelUrl);
  const direct = new URL(directUrl);
  url.protocol = direct.protocol;
  url.host = direct.host;
  return url.toString();
}

const defaultClock: Pick<SyncClock, "now" | "setTimeout" | "clearTimeout"> = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

class DirectFirstSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: SyncSocket["onclose"] = null;
  onerror: (() => void) | null = null;
  #active: SyncSocket | undefined;
  #state: "trying_direct" | "direct" | "tunnel" | "closed" = "trying_direct";
  #receivedFromDirect = false;
  #timer: unknown;

  constructor(
    private readonly inner: SyncWebSocketFactory,
    directUrl: string,
    private readonly tunnelUrl: string,
    private readonly clock: Pick<SyncClock, "now" | "setTimeout" | "clearTimeout">,
    attemptTimeoutMs: number,
    private readonly markDirectFailed: () => void,
  ) {
    try {
      this.#active = this.inner.connect(directUrl);
    } catch {
      // Nobody listens yet: a Tunnel failure here must reach the caller as a constructor error.
      this.markDirectFailed();
      this.#openTunnel();
      return;
    }
    this.#attach(this.#active, "direct");
    this.#timer = this.clock.setTimeout(() => this.#fallBack(), attemptTimeoutMs);
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
    socket.onopen = () => {
      if (!live()) return;
      this.clock.clearTimeout(this.#timer);
      if (path === "direct") this.#state = "direct";
      this.onopen?.();
    };
    socket.onmessage = (event) => {
      if (!live()) return;
      this.#receivedFromDirect = this.#receivedFromDirect || path === "direct";
      this.onmessage?.(event);
    };
    socket.onerror = () => {
      if (!live()) return;
      if (this.#state === "trying_direct") this.#fallBack();
      else this.onerror?.();
    };
    socket.onclose = (event) => {
      if (!live()) return;
      if (this.#state === "trying_direct") {
        this.#fallBack();
        return;
      }
      // Over a proxy bound before any frame arrived: the next attempt should take the Tunnel.
      if (path === "direct" && event.code === TRY_AGAIN_LATER && !this.#receivedFromDirect) this.markDirectFailed();
      this.onclose?.(event);
    };
  }

  #fallBack(): void {
    if (this.#state !== "trying_direct") return;
    this.clock.clearTimeout(this.#timer);
    this.markDirectFailed();
    abandon(this.#active);
    try {
      this.#openTunnel();
    } catch {
      this.onerror?.();
      this.onclose?.({ code: 1006, wasClean: false });
    }
  }

  #openTunnel(): void {
    this.#state = "tunnel";
    this.#active = undefined;
    this.#active = this.inner.connect(this.tunnelUrl);
    this.#attach(this.#active, "tunnel");
  }
}

function abandon(socket: SyncSocket | undefined): void {
  if (!socket) return;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  try {
    socket.close();
  } catch {
    // The abandoned socket may already be closed.
  }
}
