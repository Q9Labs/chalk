export const DEFAULT_API_BASE_URL = "https://api.chalkmeet.com";
export function defaultSyncUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.hostname.startsWith("api.")) url.hostname = `sync.${url.hostname.slice(4)}`;
  else if (url.hostname.endsWith(".chalkmeet.com")) url.hostname = url.hostname.replace(/^([^.]+-)api\./u, "$1sync.");
  url.pathname = "/v1/sync";
  url.search = "";
  url.hash = "";
  return url.toString();
}
