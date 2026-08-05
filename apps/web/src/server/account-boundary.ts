export type AccountBoundaryEnv = {
  CHALK_API_ORIGIN: string;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const MAX_BODY_BYTES = 64 * 1024;
const JOURNEY_HEADER = "x-chalk-journey-id";
const TRACEPARENT_HEADER = "traceparent";
const TRACESTATE_HEADER = "tracestate";
const IDEMPOTENCY_HEADER = "idempotency-key";
const RECENT_AUTH_HEADER = "x-chalk-recent-auth";
const CSRF_HEADER = "x-chalk-csrf";
const RECENT_AUTH_GOOGLE_MESSAGE = "chalk.recent-auth.google.complete";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_SEGMENT_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;

type BoundaryRoute = {
  upstreamPath: string;
  authenticated?: boolean;
  mutation?: boolean;
  authResult?: boolean;
  browserCallback?: boolean;
  preserveAuthOnUnauthorized?: boolean;
  queryParameters?: readonly string[];
};

export async function handleAccountBoundary(request: Request, env: AccountBoundaryEnv, fetcher: Fetcher = fetch): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const journeyID = validJourneyID(request.headers.get(JOURNEY_HEADER)) ?? crypto.randomUUID();
  let outcome = "rejected";
  let responseStatus = 500;

  try {
    if (url.pathname === "/api/healthz" && request.method === "GET") {
      const response = await boundaryHealth(env, fetcher, journeyID);
      outcome = response.ok ? "succeeded" : "failed";
      responseStatus = response.status;
      return secureResponse(response, journeyID);
    }

    if (url.pathname === "/api/auth/csrf" && request.method === "GET") {
      const token = randomToken();
      const response = jsonResponse({ csrf_token: token }, 200);
      response.headers.append("Set-Cookie", serializeCookie(csrfCookieName(url), token, url, { httpOnly: false, sameSite: "Strict", maxAge: 3600 }));
      outcome = "succeeded";
      responseStatus = response.status;
      return secureResponse(response, journeyID);
    }

    const route = resolveRoute(request.method, url.pathname);
    if (!route) {
      responseStatus = 404;
      return secureResponse(errorResponse(404, "not_found", "Route not found"), journeyID);
    }
    if (route.mutation) {
      const requestCheck = validateMutationRequest(request, url);
      if (requestCheck) {
        responseStatus = requestCheck.status;
        return secureResponse(requestCheck, journeyID);
      }
    }

    const accountToken = readCookie(request.headers.get("cookie"), accountCookieName(url));
    if (route.authenticated && !accountToken) {
      responseStatus = 401;
      return secureResponse(errorResponse(401, "unauthenticated", "Authentication required"), journeyID);
    }

    const upstreamURL = resolveUpstreamURL(env.CHALK_API_ORIGIN, route.upstreamPath, allowedSearch(url, route.queryParameters));
    const headers = upstreamHeaders(request, journeyID, accountToken);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await boundedBody(request);
    const upstream = await fetcher(upstreamURL, { method: request.method, headers, body, redirect: "manual" });
    let response: Response;
    let preserveAuthOnUnauthorized = false;

    if (route.authResult && upstream.ok) {
      const auth = await readJSONObject(upstream);
      const rawToken = stringField(auth, "session_token");
      const expiresAt = stringField(auth, "expires_at");
      const user = objectField(auth, "user");
      if (!rawToken || !expiresAt || !user) {
        response = errorResponse(502, "upstream_contract_error", "Authentication service returned an invalid response");
      } else if (url.pathname === "/api/auth/google/callback") {
        response = new Response(null, {
          status: 303,
          headers: { Location: new URL(safeReturnPath(readCookie(request.headers.get("cookie"), oauthReturnCookieName(url))), url.origin).toString() },
        });
        response.headers.append("Set-Cookie", accountCredentialCookie(url, rawToken, expiresAt));
        response.headers.append("Set-Cookie", clearCookie(oauthReturnCookieName(url), url, true));
      } else {
        response = jsonResponse({ expires_at: expiresAt, user: sanitizeUser(user) }, upstream.status);
        response.headers.append("Set-Cookie", accountCredentialCookie(url, rawToken, expiresAt));
      }
    } else if (url.pathname === "/api/auth/google/start" && upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (!location) {
        response = errorResponse(502, "upstream_contract_error", "Authentication service returned an invalid redirect");
      } else {
        response = new Response(null, { status: upstream.status, headers: { Location: location } });
        response.headers.append("Set-Cookie", serializeCookie(oauthReturnCookieName(url), safeReturnPath(url.searchParams.get("return_to")), url, { httpOnly: true, sameSite: "Lax", maxAge: 600 }));
      }
    } else {
      response = await sanitizeUpstreamResponse(upstream);
      preserveAuthOnUnauthorized = route.preserveAuthOnUnauthorized === true && (await isRecentAuthFailure(response));
      if (route.browserCallback && acceptsHTML(request)) response = await browserOAuthCallbackResponse(response, url.origin);
    }

    if (url.pathname === "/api/auth/logout") {
      response.headers.append("Set-Cookie", clearCookie(accountCookieName(url), url, true));
      response.headers.append("Set-Cookie", clearCookie(csrfCookieName(url), url, false));
    } else if (upstream.status === 401 && route.authenticated && !preserveAuthOnUnauthorized) {
      response.headers.append("Set-Cookie", clearCookie(accountCookieName(url), url, true));
    }

    outcome = response.status < 500 ? (response.ok ? "succeeded" : "rejected") : "failed";
    responseStatus = response.status;
    return secureResponse(response, journeyID);
  } catch (error) {
    outcome = "failed";
    const response = error instanceof BoundaryError ? errorResponse(error.status, error.code, error.message) : errorResponse(502, "upstream_unavailable", "Account service is unavailable");
    responseStatus = response.status;
    return secureResponse(response, journeyID);
  } finally {
    console.info(JSON.stringify({ event: "account_boundary.request", journey_id: journeyID, route: boundedRouteName(url.pathname), method: request.method, outcome, status: responseStatus, duration_ms: Date.now() - startedAt }));
  }
}

function resolveRoute(method: string, pathname: string): BoundaryRoute | undefined {
  const routes = new Map<string, BoundaryRoute>([
    ["POST /api/auth/register", { upstreamPath: "/v1/auth/register", mutation: true, authResult: true }],
    ["POST /api/auth/login", { upstreamPath: "/v1/auth/login", mutation: true, authResult: true }],
    ["POST /api/auth/logout", { upstreamPath: "/v1/auth/logout", mutation: true, authenticated: true }],
    ["GET /api/auth/google/start", { upstreamPath: "/v1/auth/google/start" }],
    ["GET /api/auth/google/callback", { upstreamPath: "/v1/auth/google/callback", authResult: true, queryParameters: ["state", "code"] }],
    ["GET /api/me", { upstreamPath: "/v1/me", authenticated: true }],
    ["POST /api/me/recent-auth", { upstreamPath: "/v1/me/recent-auth", authenticated: true, mutation: true, preserveAuthOnUnauthorized: true }],
    ["GET /api/me/recent-auth/google/start", { upstreamPath: "/v1/me/recent-auth/google/start", authenticated: true, preserveAuthOnUnauthorized: true, queryParameters: ["action", "resource_id"] }],
    ["GET /api/me/recent-auth/google/callback", { upstreamPath: "/v1/me/recent-auth/google/callback", authenticated: true, browserCallback: true, preserveAuthOnUnauthorized: true, queryParameters: ["state", "code"] }],
    ["GET /api/me/tenants", { upstreamPath: "/v1/me/tenants", authenticated: true, queryParameters: ["cursor", "page_size"] }],
    ["POST /api/me/tenants", { upstreamPath: "/v1/me/tenants", authenticated: true, mutation: true }],
    ["GET /api/regions", { upstreamPath: "/v1/regions", authenticated: true }],
  ]);
  return routes.get(`${method.toUpperCase()} ${pathname}`) ?? resolveTenantResourceRoute(method.toUpperCase(), pathname);
}

function resolveTenantResourceRoute(method: string, pathname: string): BoundaryRoute | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[0] !== "api" || segments[1] !== "tenants" || !UUID_PATTERN.test(segments[2] ?? "")) return undefined;

  const tenantID = segments[2]!;
  const resource = segments[3];
  if (resource === "spaces") return resolveSpaceRoute(method, segments, tenantID);
  if (resource === "api-keys") return resolveAPIKeyRoute(method, segments, tenantID);
  return undefined;
}

function resolveSpaceRoute(method: string, segments: string[], tenantID: string): BoundaryRoute | undefined {
  const base = `/v1/tenants/${tenantID}/spaces`;
  if (segments.length === 4) {
    if (method === "GET") return { upstreamPath: base, authenticated: true, queryParameters: ["cursor", "page_size", "archived"] };
    if (method === "POST") return { upstreamPath: base, authenticated: true, mutation: true };
    return undefined;
  }

  const spaceID = segments[4];
  if (!spaceID || !UUID_PATTERN.test(spaceID)) return undefined;
  const spacePath = `${base}/${spaceID}`;
  if (segments.length === 5) {
    if (method === "GET") return { upstreamPath: spacePath, authenticated: true };
    if (method === "PATCH") return { upstreamPath: spacePath, authenticated: true, mutation: true };
    return undefined;
  }
  if (segments[5] === "archive" && segments.length === 6 && method === "POST") return { upstreamPath: `${spacePath}/archive`, authenticated: true, mutation: true };
  if (segments[5] === "restore" && segments.length === 6 && method === "POST") return { upstreamPath: `${spacePath}/restore`, authenticated: true, mutation: true };
  if (segments[5] !== "episodes") return undefined;

  const episodesPath = `${spacePath}/episodes`;
  if (segments.length === 6) {
    if (method === "GET") return { upstreamPath: episodesPath, authenticated: true, queryParameters: ["cursor", "page_size"] };
    if (method === "POST") return { upstreamPath: episodesPath, authenticated: true, mutation: true };
    return undefined;
  }
  const episodeID = segments[6];
  if (!episodeID || !UUID_PATTERN.test(episodeID)) return undefined;
  const episodePath = `${episodesPath}/${episodeID}`;
  if (segments.length === 7 && method === "GET") return { upstreamPath: episodePath, authenticated: true };
  if (segments.length === 8 && segments[7] === "end" && method === "POST") return { upstreamPath: `${episodePath}/end`, authenticated: true, mutation: true };
  return undefined;
}

function resolveAPIKeyRoute(method: string, segments: string[], tenantID: string): BoundaryRoute | undefined {
  const base = `/v1/tenants/${tenantID}/api-keys`;
  if (segments.length === 4) {
    if (method === "GET") return { upstreamPath: base, authenticated: true, queryParameters: ["cursor", "page_size"] };
    if (method === "POST") return { upstreamPath: base, authenticated: true, mutation: true, preserveAuthOnUnauthorized: true };
    return undefined;
  }
  const apiKeyID = segments[4];
  if (!apiKeyID || !UUID_PATTERN.test(apiKeyID)) return undefined;
  const apiKeyPath = `${base}/${apiKeyID}`;
  if (segments.length === 5 && method === "DELETE") return { upstreamPath: apiKeyPath, authenticated: true, mutation: true, preserveAuthOnUnauthorized: true };
  if (segments.length === 6 && segments[5] === "rotate" && method === "POST") return { upstreamPath: `${apiKeyPath}/rotate`, authenticated: true, mutation: true, preserveAuthOnUnauthorized: true };
  return undefined;
}

function allowedSearch(url: URL, names: readonly string[] | undefined): string {
  if (!names?.length) return "";
  const allowed = new URLSearchParams();
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null) allowed.set(name, value);
  }
  const query = allowed.toString();
  return query ? `?${query}` : "";
}

function validateMutationRequest(request: Request, url: URL): Response | undefined {
  const source = request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return errorResponse(403, "origin_required", "A same-origin request is required");
  try {
    if (new URL(source).origin !== url.origin) return errorResponse(403, "origin_mismatch", "A same-origin request is required");
  } catch {
    return errorResponse(403, "origin_mismatch", "A same-origin request is required");
  }
  const cookieToken = readCookie(request.headers.get("cookie"), csrfCookieName(url));
  const headerToken = request.headers.get(CSRF_HEADER)?.trim();
  if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
    return errorResponse(403, "csrf_mismatch", "CSRF validation failed");
  }
  return undefined;
}

function upstreamHeaders(request: Request, journeyID: string, accountToken?: string): Headers {
  const headers = new Headers({ Accept: "application/json", [JOURNEY_HEADER]: journeyID });
  if (request.headers.get("content-type")) headers.set("Content-Type", "application/json");
  if (accountToken) headers.set("Authorization", `Bearer ${accountToken}`);
  const requestKey = request.headers.get(IDEMPOTENCY_HEADER);
  if (requestKey) headers.set("Idempotency-Key", requestKey);
  const recentAuth = request.headers.get(RECENT_AUTH_HEADER);
  if (recentAuth && recentAuth.length <= 2048 && !/[\r\n]/.test(recentAuth)) headers.set("X-Chalk-Recent-Auth", recentAuth);
  const traceparent = request.headers.get(TRACEPARENT_HEADER);
  if (traceparent && TRACEPARENT_PATTERN.test(traceparent)) headers.set(TRACEPARENT_HEADER, traceparent.toLowerCase());
  const tracestate = request.headers.get(TRACESTATE_HEADER);
  if (tracestate && tracestate.length <= 512 && !/[\r\n]/.test(tracestate)) headers.set(TRACESTATE_HEADER, tracestate);
  return headers;
}

async function boundedBody(request: Request): Promise<ArrayBuffer | undefined> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new BoundaryError(415, "unsupported_media_type", "Content-Type must be application/json");
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new BoundaryError(413, "payload_too_large", "Request body is too large");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) throw new BoundaryError(413, "payload_too_large", "Request body is too large");
  return body;
}

async function sanitizeUpstreamResponse(upstream: Response): Promise<Response> {
  if (upstream.status === 204) return new Response(null, { status: 204 });
  const value = await readJSONObject(upstream);
  if (upstream.ok) return jsonResponse(stripTokenFields(value), upstream.status);
  const error = objectField(value, "error");
  const code = error ? stringField(error, "code") : undefined;
  const message = error ? stringField(error, "message") : undefined;
  return errorResponse(upstream.status, code ?? "upstream_error", message ?? "Request failed");
}

async function isRecentAuthFailure(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const value = await readJSONObject(response.clone());
  const error = objectField(value, "error");
  return ["auth.invalid_recent_auth", "access.recent_auth_required"].includes(stringField(error ?? {}, "code") ?? "");
}

function acceptsHTML(request: Request): boolean {
  const accept = request.headers.get("accept");
  return !accept || accept.split(",").some((value) => value.trim().toLowerCase().startsWith("text/html"));
}

async function browserOAuthCallbackResponse(response: Response, origin: string): Promise<Response> {
  const value = await readJSONObject(response.clone());
  const error = objectField(value, "error");
  const proof = stringField(value, "proof");
  const expiresAt = stringField(value, "expires_at");
  const payload = proof && expiresAt ? { type: RECENT_AUTH_GOOGLE_MESSAGE, proof, expires_at: expiresAt } : { type: RECENT_AUTH_GOOGLE_MESSAGE, error: { code: stringField(error ?? {}, "code") ?? "recent_auth_failed", message: stringField(error ?? {}, "message") ?? "Recent authentication failed" } };
  const nonce = randomToken();
  const serializedPayload = safeInlineJSON(payload);
  const serializedOrigin = safeInlineJSON(origin);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Returning to Chalk</title></head><body><p>Returning to Chalk…</p><script nonce="${nonce}">window.opener?.postMessage(${serializedPayload},${serializedOrigin});window.close();</script></body></html>`;
  return new Response(html, {
    status: response.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
      Pragma: "no-cache",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}

function safeInlineJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

async function boundaryHealth(env: AccountBoundaryEnv, fetcher: Fetcher, journeyID: string): Promise<Response> {
  try {
    const upstreamURL = resolveUpstreamURL(env.CHALK_API_ORIGIN, "/healthz", "");
    const upstream = await fetcher(upstreamURL, { headers: { Accept: "application/json", [JOURNEY_HEADER]: journeyID }, signal: AbortSignal.timeout(2000) });
    return jsonResponse({ status: upstream.ok ? "ok" : "unavailable", dependencies: { account_api: upstream.ok ? "ok" : "unavailable" } }, upstream.ok ? 200 : 503);
  } catch {
    return jsonResponse({ status: "unavailable", dependencies: { account_api: "unavailable" } }, 503);
  }
}

function resolveUpstreamURL(rawOrigin: string, pathname: string, search: string): URL {
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new BoundaryError(503, "boundary_misconfigured", "Account boundary is not configured");
  }
  const local = origin.hostname === "127.0.0.1" || origin.hostname === "localhost" || origin.hostname === "::1";
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))) {
    throw new BoundaryError(503, "boundary_misconfigured", "Account boundary is not configured");
  }
  return new URL(`${pathname}${search}`, origin);
}

function secureResponse(response: Response, journeyID: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, private");
  headers.set("Pragma", "no-cache");
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set(JOURNEY_HEADER, journeyID);
  headers.set("Vary", "Cookie, Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function accountCredentialCookie(url: URL, token: string, expiresAt: string): string {
  const expires = new Date(expiresAt);
  if (!Number.isFinite(expires.getTime())) throw new BoundaryError(502, "upstream_contract_error", "Authentication service returned an invalid expiry");
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
  return serializeCookie(accountCookieName(url), token, url, { httpOnly: true, sameSite: "Lax", maxAge, expires });
}

function serializeCookie(name: string, value: string, url: URL, options: { httpOnly: boolean; sameSite: "Lax" | "Strict"; maxAge: number; expires?: Date }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${options.maxAge}`, `SameSite=${options.sameSite}`];
  if (url.protocol === "https:") parts.push("Secure");
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join("; ");
}

function clearCookie(name: string, url: URL, httpOnly: boolean): string {
  return serializeCookie(name, "", url, { httpOnly, sameSite: name.includes("csrf") ? "Strict" : "Lax", maxAge: 0, expires: new Date(0) });
}

function accountCookieName(url: URL): string {
  return url.protocol === "https:" ? "__Host-chalk_account" : "chalk_account_local";
}

function csrfCookieName(url: URL): string {
  return url.protocol === "https:" ? "__Host-chalk_csrf" : "chalk_csrf_local";
}

function oauthReturnCookieName(url: URL): string {
  return url.protocol === "https:" ? "__Host-chalk_oauth_return" : "chalk_oauth_return_local";
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [rawName, ...rest] = item.trim().split("=");
    if (rawName === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/home";
  return value;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function validJourneyID(value: string | null): string | undefined {
  return value && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

async function readJSONObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // The caller maps malformed upstream bodies to a stable boundary error.
  }
  return {};
}

function stripTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTokenFields);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["session_token", "access_token", "refresh_token", "token"].includes(key.toLowerCase())) continue;
    result[key] = stripTokenFields(child);
  }
  return result;
}

function sanitizeUser(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["id", "name", "email", "updated_at", "created_at"].flatMap((key) => (typeof value[key] === "string" ? [[key, value[key]]] : [])));
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const child = value[key];
  return child && typeof child === "object" && !Array.isArray(child) ? (child as Record<string, unknown>) : undefined;
}

function boundedRouteName(pathname: string): string {
  return pathname.startsWith("/api/") && pathname.length <= 160 ? pathname.replaceAll(UUID_SEGMENT_PATTERN, "{id}") : "/api/unknown";
}

class BoundaryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
