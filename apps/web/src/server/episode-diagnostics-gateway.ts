import { JOURNEY_HEADER, accountCookieName, csrfCookieName, forwardedContextHeaders, hasMatchingCsrfProof, readCookie, stripTokenFields, validJourneyID } from "./request-safety";

export type EpisodeDiagnosticsGatewayEnv = {
  CHALK_API_ORIGIN?: string;
  CHALK_EPISODE_DIAGNOSTICS_API_ORIGIN?: string;
  CHALK_EPISODE_DIAGNOSTICS_SIGNED_DOWNLOAD_HOSTS?: string;
  CHALK_EPISODE_DIAGNOSTICS_GATEWAY?: string;
  CHALK_EPISODE_DIAGNOSTICS?: string;
  CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN?: string;
  CHALK_ENVIRONMENT?: string;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DIAGNOSTICS_PATH = "/_internal/episode-diagnostics";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 2;
const MAX_URL_LENGTH = 16 * 1024;
const MAX_QUERY_VALUE_LENGTH = 8 * 1024;
const CSRF_HEADER = "x-chalk-csrf";
const ALLOWED_METHODS = new Set(["GET", "POST", "DELETE"]);
const ALLOWED_QUERY_PARAMETERS = new Set(["after", "before", "limit", "filters", "format", "cursor", "around_seconds", "branch_id", "last_event_id", "latest"]);
const FORWARDED_HEADERS = ["accept", "content-type", "idempotency-key", "last-event-id"] as const;
const DOWNLOAD_CONTENT_TYPE = /^(?:application\/(?:gzip|json|octet-stream|pdf|zip|x-gzip|x-ndjson)|text\/(?:csv|plain))(?:;|$)/i;

export async function handleEpisodeDiagnosticsGateway(request: Request, env: EpisodeDiagnosticsGatewayEnv, fetcher: Fetcher = fetch): Promise<Response> {
  const startedAt = Date.now();
  const requestURL = new URL(request.url);
  const journeyID = validJourneyID(request.headers.get(JOURNEY_HEADER)) ?? crypto.randomUUID();
  let responseStatus = 500;
  let outcome = "rejected";

  try {
    const failure = validateRequest(request, requestURL, env);
    if (failure) {
      responseStatus = failure.status;
      return secureResponse(failure, journeyID);
    }

    const accountToken = readCookie(request.headers.get("cookie"), accountCookieName(requestURL));
    if (!accountToken) {
      responseStatus = 401;
      return secureResponse(errorResponse(401, "access.unauthenticated", "Authentication required"), journeyID);
    }

    const upstreamOrigin = resolveOrigin(env.CHALK_EPISODE_DIAGNOSTICS_API_ORIGIN ?? env.CHALK_API_ORIGIN);
    const contextHeaders = forwardedContextHeaders(request, journeyID);
    contextHeaders.set("authorization", `Bearer ${accountToken}`);
    contextHeaders.set("accept", "application/json");
    const accountResponse = await fetcher(new URL("/v1/me", upstreamOrigin), {
      method: "GET",
      headers: contextHeaders,
      redirect: "manual",
    });
    if (!accountResponse.ok) {
      responseStatus = accountResponse.status === 401 || accountResponse.status === 403 ? 401 : 502;
      return secureResponse(errorResponse(responseStatus, responseStatus === 401 ? "access.unauthenticated" : "account.unavailable", responseStatus === 401 ? "Authentication required" : "Account service is unavailable"), journeyID);
    }

    const body = await requestBody(request);
    const upstreamURL = diagnosticURL(requestURL, upstreamOrigin);
    const headers = accountHeaders(request, journeyID, accountToken);
    const upstream = await fetcher(upstreamURL, { method: request.method, headers, body, redirect: "manual" });
    const response = await sanitizeGatewayResponse(upstream, requestURL, upstreamURL, env, fetcher);
    responseStatus = response.status;
    outcome = response.ok ? "succeeded" : response.status >= 500 ? "failed" : "rejected";
    return secureResponse(response, journeyID);
  } catch (error) {
    responseStatus = error instanceof GatewayError ? error.status : 502;
    return secureResponse(errorResponse(responseStatus, error instanceof GatewayError ? error.code : "request.failed", error instanceof GatewayError ? error.message : "Episode Diagnostics service is unavailable"), journeyID);
  } finally {
    console.info(JSON.stringify({ event: "episode_diagnostics.gateway", journey_id: journeyID, route: boundedRoute(requestURL.pathname), method: request.method, outcome, status: responseStatus, duration_ms: Date.now() - startedAt }));
  }
}

function validateRequest(request: Request, url: URL, env: EpisodeDiagnosticsGatewayEnv): Response | undefined {
  if (!ALLOWED_METHODS.has(request.method.toUpperCase())) return errorResponse(405, "request.method_not_allowed", "Episode Diagnostics gateway method is not allowed");
  if (url.toString().length > MAX_URL_LENGTH || !isDiagnosticPath(url.pathname)) return errorResponse(404, "route.not_found", "Route not found");

  for (const source of [request.headers.get("origin"), request.headers.get("referer")]) {
    if (!source) continue;
    try {
      if (new URL(source).origin !== url.origin) return errorResponse(403, "origin.mismatch", "A same-origin request is required");
    } catch {
      return errorResponse(403, "origin.mismatch", "A same-origin request is required");
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return errorResponse(403, "origin.mismatch", "A same-origin request is required");
  if (request.method.toUpperCase() !== "GET") {
    const source = request.headers.get("origin") ?? request.headers.get("referer");
    if (!source) return errorResponse(403, "origin.required", "A same-origin request is required");
    if (!hasMatchingCsrfProof(request, csrfCookieName(url), CSRF_HEADER)) return errorResponse(403, "csrf.mismatch", "CSRF validation failed");
  }
  const environment = env.CHALK_ENVIRONMENT?.trim() ?? "";
  const hostedEnvironmentAllowed = ["development", "staging"].includes(environment) || (environment === "production" && env.CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN === "true");
  if (env.CHALK_EPISODE_DIAGNOSTICS_GATEWAY?.trim() !== "verified" || env.CHALK_EPISODE_DIAGNOSTICS?.trim() !== "hosted" || !hostedEnvironmentAllowed) {
    return errorResponse(503, "gateway.misconfigured", "Episode Diagnostics gateway is not enabled for this environment");
  }
  return undefined;
}

function isDiagnosticPath(pathname: string): boolean {
  if (!pathname.startsWith(`${DIAGNOSTICS_PATH}/`) || pathname.includes("\\") || pathname.includes("//") || pathname.includes("..") || pathname.includes("\u0000")) return false;
  return pathname
    .split("/")
    .slice(1)
    .every((segment) => segment.length > 0 && segment.length <= 512);
}

async function requestBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (request.method === "GET") return undefined;
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new GatewayError(415, "request.unsupported_media_type", "Content-Type must be application/json");
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new GatewayError(413, "request.payload_too_large", "Request body is too large");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) throw new GatewayError(413, "request.payload_too_large", "Request body is too large");
  return body;
}

function diagnosticURL(requestURL: URL, origin: URL): URL {
  const upstreamURL = new URL(`${requestURL.pathname}${allowedSearch(requestURL)}`, origin);
  if (upstreamURL.origin !== origin.origin || !isDiagnosticPath(upstreamURL.pathname)) throw new GatewayError(400, "route.unsafe_path", "Diagnostic route is not safe");
  return upstreamURL;
}

function allowedSearch(url: URL): string {
  const search = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    if (!ALLOWED_QUERY_PARAMETERS.has(name) || value.length > MAX_QUERY_VALUE_LENGTH) continue;
    search.append(name, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function accountHeaders(request: Request, journeyID: string, accountToken: string): Headers {
  const headers = forwardedContextHeaders(request, journeyID);
  headers.set("authorization", `Bearer ${accountToken}`);
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (!value || value.length > 8 * 1024 || /[\r\n]/.test(value)) continue;
    headers.set(name, value);
  }
  return headers;
}

async function sanitizeResponse(response: Response): Promise<Response> {
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (contentType?.toLowerCase().includes("application/json")) {
    try {
      const value = await response.json();
      return new Response(JSON.stringify(stripTokenFields(value, ["authorization", "secret", "credential"])), { status: response.status, headers });
    } catch {
      return new Response(JSON.stringify({ code: "upstream.contract_error", message: "Diagnostics service returned malformed JSON" }), { status: 502, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function sanitizeGatewayResponse(response: Response, requestURL: URL, upstreamURL: URL, env: EpisodeDiagnosticsGatewayEnv, fetcher: Fetcher): Promise<Response> {
  if (isDownloadPath(requestURL.pathname)) {
    const download = await followSignedDownload(response, upstreamURL, env, fetcher);
    return sanitizeDownloadResponse(download);
  }
  return sanitizeResponse(response);
}

async function followSignedDownload(response: Response, upstreamURL: URL, env: EpisodeDiagnosticsGatewayEnv, fetcher: Fetcher): Promise<Response> {
  let currentResponse = response;
  let currentURL = upstreamURL;
  for (let redirectCount = 0; isRedirect(currentResponse.status); redirectCount += 1) {
    if (redirectCount >= MAX_DOWNLOAD_REDIRECTS) throw new GatewayError(502, "download.redirect_limit", "The signed diagnostic download redirected too many times");
    const location = currentResponse.headers.get("location");
    if (!location) throw new GatewayError(502, "download.redirect_invalid", "The signed diagnostic download omitted its redirect location");
    const signedURL = validateSignedDownloadURL(location, currentURL, env.CHALK_EPISODE_DIAGNOSTICS_SIGNED_DOWNLOAD_HOSTS);
    currentResponse = await fetcher(signedURL, { method: "GET", redirect: "manual", credentials: "omit" });
    currentURL = signedURL;
  }
  return currentResponse;
}

function isDownloadPath(pathname: string): boolean {
  return /\/export-jobs\/[^/]+\/download$/u.test(pathname);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function validateSignedDownloadURL(rawLocation: string, currentURL: URL, rawHosts: string | undefined): URL {
  const allowedHosts = new Set(
    (rawHosts ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedHosts.size === 0) throw new GatewayError(503, "download.misconfigured", "Signed diagnostic download hosts are not configured");
  let location: URL;
  try {
    location = new URL(rawLocation, currentURL);
  } catch {
    throw new GatewayError(502, "download.redirect_invalid", "The signed diagnostic download location is invalid");
  }
  if (location.protocol !== "https:" || location.username || location.password || location.hash || !allowedHosts.has(location.host.toLowerCase())) {
    throw new GatewayError(502, "download.redirect_invalid", "The signed diagnostic download location is not allowlisted");
  }
  return location;
}

async function sanitizeDownloadResponse(response: Response): Promise<Response> {
  const body = await boundedDownloadBody(response);
  const headers = new Headers();
  const contentType = safeDownloadContentType(response.headers.get("content-type"));
  if (contentType) headers.set("content-type", contentType);
  const disposition = safeContentDisposition(response.headers.get("content-disposition"));
  if (disposition) headers.set("content-disposition", disposition);
  const checksum = response.headers.get("x-chalk-diagnostic-checksum");
  if (checksum && /^[a-f0-9]{64}$/iu.test(checksum)) headers.set("x-chalk-diagnostic-checksum", checksum.toLowerCase());
  headers.set("content-length", String(body.byteLength));
  return new Response(body as unknown as BodyInit, { status: response.status, statusText: response.statusText, headers });
}

async function boundedDownloadBody(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_DOWNLOAD_BYTES)) {
    throw new GatewayError(413, "download.too_large", "The diagnostic download exceeds the gateway size limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new GatewayError(413, "download.too_large", "The diagnostic download exceeds the gateway size limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function safeDownloadContentType(value: string | null): string | undefined {
  if (!value) return undefined;
  const contentType = value.trim();
  if (contentType.length > 256 || /[\r\n]/u.test(contentType) || !DOWNLOAD_CONTENT_TYPE.test(contentType)) throw new GatewayError(502, "download.content_type_invalid", "The diagnostic download content type is not allowed");
  return contentType;
}

function safeContentDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const disposition = value.trim();
  if (disposition.length > 512 || /[\r\n\\/]/u.test(disposition) || !/^attachment(?:;\s*filename(?:\*?)=(?:"[A-Za-z0-9._ -]{1,160}"|[A-Za-z0-9._-]{1,160}))?$/iu.test(disposition)) throw new GatewayError(502, "download.disposition_invalid", "The diagnostic download disposition is not allowed");
  return disposition;
}

function secureResponse(response: Response, journeyID: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("authorization");
  headers.set("cache-control", "no-store, private");
  headers.set("pragma", "no-cache");
  if (!headers.has("content-security-policy")) headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("referrer-policy", "same-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("vary", "Cookie, Origin");
  headers.set(JOURNEY_HEADER, journeyID);
  if (headers.get("content-type")?.toLowerCase().includes("text/event-stream")) headers.set("x-accel-buffering", "no");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function resolveOrigin(rawOrigin: string | undefined): URL {
  if (!rawOrigin) throw new GatewayError(503, "gateway.misconfigured", "Episode Diagnostics gateway has no upstream origin");
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new GatewayError(503, "gateway.misconfigured", "Episode Diagnostics gateway has an invalid upstream origin");
  }
  const local = origin.hostname === "127.0.0.1" || origin.hostname === "localhost" || origin.hostname === "[::1]";
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))) {
    throw new GatewayError(503, "gateway.misconfigured", "Episode Diagnostics gateway has an unsafe upstream origin");
  }
  return origin;
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message }), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function boundedRoute(pathname: string): string {
  return pathname.startsWith(DIAGNOSTICS_PATH) && pathname.length <= 180 ? pathname : `${DIAGNOSTICS_PATH}/unknown`;
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EpisodeDiagnosticsGatewayError";
  }
}
