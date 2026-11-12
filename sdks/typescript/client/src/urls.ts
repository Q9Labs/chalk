export const DEFAULT_API_BASE_URL = "https://api.chalkmeet.com";
export const SYNC_PATH = "/v1/sync";
export const WHITEBOARD_PATH = "/v1/whiteboard";

/** An API that binds a call to the own SFU does so only for an SDK that says which media providers it runs. */
export const MEDIA_PROVIDERS_HEADER = "X-Chalk-Media-Providers";
export const MEDIA_PROVIDERS = "cloudflare_sfu,chalk_sfu";

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

/** The API origin with its path kept and without query, fragment or trailing slash. */
export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = trimTrailingSlashes(url.pathname);
  url.search = "";
  url.hash = "";
  return trimTrailingSlashes(url.toString());
}

export function defaultSyncUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.hostname.startsWith("api.")) url.hostname = `sync.${url.hostname.slice(4)}`;
  else if (url.hostname.endsWith(".chalkmeet.com")) url.hostname = url.hostname.replace(/^([^.]+-)api\./u, "$1sync.");
  url.pathname = SYNC_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function whiteboardUrl(syncUrl: string): string {
  const url = new URL(syncUrl);
  url.pathname = WHITEBOARD_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The Sync URL on the public host a grant advertises. */
export function directSyncUrl(origin: URL): string {
  return `wss://${origin.host}${SYNC_PATH}`;
}
