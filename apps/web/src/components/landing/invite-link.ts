const SPACE_PATH = /^\/space\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Returns a safe Space URL without moving invite credentials into a query string. */
export function resolveSpaceInviteLink(value: string, origin: string): string | undefined {
  const input = value.trim();
  if (!input || input.startsWith("//") || (!input.startsWith("/") && !/^https?:\/\//i.test(input))) return undefined;

  let url: URL;
  try {
    url = new URL(input, origin);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.search || url.username || url.password) return undefined;
  if (!SPACE_PATH.test(url.pathname)) return undefined;

  return url.toString();
}
