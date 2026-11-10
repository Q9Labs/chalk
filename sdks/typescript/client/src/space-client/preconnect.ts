import { releaseWarmBrowserSyncSocket, warmBrowserSyncSocket } from "../sync/browser";
import { MAX_KEEP_WARM_MS } from "../sync/warm-socket";
import { directFirstWarmUrl } from "../sync/direct-first";
import { syncEntryUrl } from "../sync/entry-url";
import { DEFAULT_API_BASE_URL, defaultSyncUrl } from "./urls";

export type PreconnectOptions = {
  /** The API base URL the client will use. Defaults to the same value as `createSpaceClient`. */
  readonly baseUrl?: string;
  /** The Sync URL, when it is not the default derived from `baseUrl`. */
  readonly syncUrl?: string;
  /** The direct Sync URL, when the client is built with `syncDirectUrl`: the warm socket then opens where that client dials first, so it is adopted. */
  readonly syncDirectUrl?: string | undefined;
  /**
   * How long to keep a socket ready after this call, in ms (0 to 16000, default 0). Sync closes an unused socket after 5 s, so
   * a socket that ages out is replaced by a new one until this window ends. A failed upgrade ends the window. Use it for a
   * screen where the person may take several seconds to press Join, and call `preconnect` again as they act.
   */
  readonly keepWarmMs?: number;
};

/**
 * Starts the network setup a join will need while the person is still on a lobby or pre-join screen: the browser opens
 * its TCP and TLS connection to the API, and the Sync WebSocket upgrade runs, so `join()` finds both ready. The first
 * Sync client built in a browser for the same Sync URL adopts the socket. It asks for no grant, holds no seat, sends
 * no frame and starts no media, so there is nothing to cancel when the person leaves. Sync closes a socket that gets
 * no hello within 5 s, so the socket is dropped after 4 s unused: pass `keepWarmMs` to have a new one opened until that
 * window ends, and call `preconnect` again as the person acts (typing a name, pressing Join). Calling it while a socket is
 * upgrading or open never starts a second upgrade. The socket is not tied to a Space, so it serves a join in any Space of the
 * tab, including the next call after a leave. It does nothing outside a browser page.
 */
export function preconnect(options: PreconnectOptions = {}): void {
  if (typeof document === "undefined") return;
  const baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL;
  const origin = new URL(baseUrl).origin;
  if (!document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    // Calls to this origin send an Authorization header, so the browser opens it in CORS mode.
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }
  warmBrowserSyncSocket(directFirstWarmUrl(options.syncDirectUrl, syncEntryUrl(options.syncUrl ?? defaultSyncUrl(baseUrl), null, true)), Math.min(options.keepWarmMs ?? 0, MAX_KEEP_WARM_MS));
}

/**
 * Closes the socket `preconnect` holds and stops keeping one. Call it at sign-out. The socket carries no credential, so this
 * ends a resource rather than revoking access.
 */
export function releasePreconnect(): void {
  releaseWarmBrowserSyncSocket();
}
