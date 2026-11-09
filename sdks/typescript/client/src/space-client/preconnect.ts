import { DEFAULT_API_BASE_URL, defaultSyncUrl } from "./core";

export type PreconnectOptions = {
  /** The API base URL the client will use. Defaults to the same value as `createSpaceClient`. */
  readonly baseUrl?: string;
  /** The Sync URL, when it is not the default derived from `baseUrl`. */
  readonly syncUrl?: string;
};

/**
 * Asks the browser to open the TCP and TLS connections a join will use, so `join()` skips those round trips.
 * Call it while the person is still on a lobby or pre-join screen. It sends no request, asks for no grant, holds no
 * seat and starts no media, so there is nothing to cancel when the person leaves. A browser may close an idle
 * connection after a few seconds, so a long wait gets only part of the saving. It does nothing outside a browser page.
 */
export function preconnect(options: PreconnectOptions = {}): void {
  const head = globalThis.document?.head;
  if (!head) return;
  const baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL;
  const origins = new Set([new URL(baseUrl).origin, httpOrigin(options.syncUrl ?? defaultSyncUrl(baseUrl))]);
  for (const origin of origins) {
    if (head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) continue;
    const link = globalThis.document.createElement("link");
    link.rel = "preconnect";
    link.href = origin;
    // Calls to these origins send an Authorization header, so the browser opens them in CORS mode.
    link.crossOrigin = "anonymous";
    head.append(link);
  }
}

function httpOrigin(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return parsed.origin;
}
