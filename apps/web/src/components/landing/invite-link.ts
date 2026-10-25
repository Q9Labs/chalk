import { parseInviteCode } from "@q9labsai/chalk-client/invites";

const SPACE_PATH = /^\/space\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHALK_HOSTS = new Set(["chalkmeet.com", "www.chalkmeet.com"]);

/**
 * Returns the path and hash of a pasted call link on this site, or undefined when it isn't one.
 * The hash carries the invite, so it stays out of the query string and the server logs.
 */
export function callPathFromLink(value: string, origin: string): string | undefined {
  const input = value.trim();
  if (!input || input.startsWith("//")) return undefined;

  const bareCode = parseInviteCode(input);
  if (bareCode) return `/${bareCode}`;

  let url: URL;
  try {
    url = input.startsWith("/") ? new URL(input, origin) : new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return undefined;
  }

  if (url.host !== new URL(origin).host && !CHALK_HOSTS.has(url.host)) return undefined;
  if (url.search || url.username || url.password) return undefined;
  let code: string | undefined;
  try {
    code = parseInviteCode(decodeURIComponent(url.pathname.slice(1)));
  } catch {
    return undefined;
  }
  if (code) return `/${code}`;
  if (!SPACE_PATH.test(url.pathname)) return undefined;
  return url.pathname + url.hash;
}
