import { parkBrowserSyncSocket } from "../sync/browser";
import { syncEntryUrl } from "../sync/entry-url";
import { DEFAULT_API_BASE_URL, defaultSyncUrl } from "./urls";

export type PreconnectOptions = {
  /** The API base URL the client will use. Defaults to the same value as `createSpaceClient`. */
  readonly baseUrl?: string;
  /** The Sync URL, when it is not the default derived from `baseUrl`. */
  readonly syncUrl?: string;
};

/**
 * Starts the network setup a join will need while the person is still on a lobby or pre-join screen: the browser opens
 * its TCP and TLS connection to the API, and the Sync WebSocket upgrade runs, so `join()` finds both ready. The first
 * Sync client built in a browser for the same Sync URL adopts the socket. It asks for no grant, holds no seat, sends
 * no frame and starts no media, so there is nothing to cancel when the person leaves. Sync closes a socket that gets
 * no hello within 5 s, so the socket is dropped after 4 s unused and calling `preconnect` again opens a new one: call it
 * again as the person acts (typing a name, pressing Join). It does nothing outside a browser page.
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
  parkBrowserSyncSocket(syncEntryUrl(options.syncUrl ?? defaultSyncUrl(baseUrl), null, true));
}
