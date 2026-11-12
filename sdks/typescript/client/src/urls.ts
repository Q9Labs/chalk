export const DEFAULT_API_BASE_URL = "https://api.chalkmeet.com";
export const SYNC_PATH = "/v1/sync";
export const WHITEBOARD_PATH = "/v1/whiteboard";

/** An API that binds a call to the own SFU does so only for an SDK that says which media providers it runs. */
export const MEDIA_PROVIDERS_HEADER = "X-Chalk-Media-Providers";
export const MEDIA_PROVIDERS = "cloudflare_sfu,chalk_sfu";

export const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/u, "");

/** The URL moved to a path, without query or fragment. */
function atPath(url: URL, pathname: string): string {
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The API origin with its path kept and without query, fragment or trailing slash. */
export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  return trimTrailingSlashes(atPath(url, trimTrailingSlashes(url.pathname)));
}

export function defaultSyncUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.hostname.startsWith("api.")) url.hostname = `sync.${url.hostname.slice(4)}`;
  else if (url.hostname.endsWith(".chalkmeet.com")) url.hostname = url.hostname.replace(/^([^.]+-)api\./u, "$1sync.");
  return atPath(url, SYNC_PATH);
}

export const whiteboardUrl = (syncUrl: string): string => atPath(new URL(syncUrl), WHITEBOARD_PATH);

/** The Sync URL on the public host a grant advertises. */
export const directSyncUrl = (origin: URL): string => `wss://${origin.host}${SYNC_PATH}`;
