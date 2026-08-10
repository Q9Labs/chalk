export const JOURNEY_HEADER = "x-chalk-journey-id";
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRACEPARENT_HEADER = "traceparent";
const TRACESTATE_HEADER = "tracestate";
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;

const ACCOUNT_COOKIE_HTTPS = "__Host-chalk_account";
const ACCOUNT_COOKIE_HTTP = "chalk_account_local";
const CSRF_COOKIE_HTTPS = "__Host-chalk_csrf";
const CSRF_COOKIE_HTTP = "chalk_csrf_local";

export function forwardedContextHeaders(request: Request, journeyID: string): Headers {
  const headers = new Headers({ [JOURNEY_HEADER]: journeyID });
  const traceparent = request.headers.get(TRACEPARENT_HEADER);
  if (traceparent && TRACEPARENT_PATTERN.test(traceparent)) headers.set(TRACEPARENT_HEADER, traceparent.toLowerCase());
  const tracestate = request.headers.get(TRACESTATE_HEADER);
  if (tracestate && tracestate.length <= 512 && !/[\r\n]/.test(tracestate)) headers.set(TRACESTATE_HEADER, tracestate);
  return headers;
}

export function accountCookieName(url: URL): string {
  return url.protocol === "https:" ? ACCOUNT_COOKIE_HTTPS : ACCOUNT_COOKIE_HTTP;
}

export function csrfCookieName(url: URL): string {
  return url.protocol === "https:" ? CSRF_COOKIE_HTTPS : CSRF_COOKIE_HTTP;
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [rawName, ...rest] = item.trim().split("=");
    if (rawName !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function hasMatchingCsrfProof(request: Request, cookieName: string, headerName: string): boolean {
  const cookieToken = readCookie(request.headers.get("cookie"), cookieName);
  const headerToken = request.headers.get(headerName)?.trim();
  return Boolean(cookieToken && headerToken && timingSafeEqual(cookieToken, headerToken));
}

export function validJourneyID(value: string | null): string | undefined {
  return value && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

export function stripTokenFields(value: unknown, extraKeys: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((child) => stripTokenFields(child, extraKeys));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "token" || normalizedKey.endsWith("_token") || extraKeys.includes(normalizedKey)) continue;
    result[key] = stripTokenFields(child, extraKeys);
  }
  return result;
}
