import { ASSET_RECORDS, ATLAS_BUILD_ID, ATLAS_CSP, ATLAS_HTML } from "../.generated/atlas";

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Environment {
  ATLAS_ACCESS_CODE_SHA256: string;
  ATLAS_SESSION_SECRET: string;
  LOGIN_RATE_LIMITER: RateLimitBinding;
}

const SESSION_COOKIE = "__Host-chalk_atlas_session";
const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") || "";
  for (const cookie of cookies.split(";")) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

async function createSession(secret: string): Promise<string> {
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        version: 1,
        expiresAt: Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS,
        nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
      }),
    ),
  );
  return `${payload}.${await hmac(payload, secret)}`;
}

async function hasValidSession(request: Request, env: Environment): Promise<boolean> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !env.ATLAS_SESSION_SECRET) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !constantTimeEqual(signature, await hmac(payload, env.ATLAS_SESSION_SECRET))) return false;
  const decoded = base64UrlDecode(payload);
  if (!decoded) return false;
  try {
    const session = JSON.parse(decoder.decode(decoded)) as { version?: number; expiresAt?: number };
    return session.version === 1 && typeof session.expiresAt === "number" && session.expiresAt > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function safeReturnPath(value: string | null): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !value.startsWith("/_auth/") ? value : "/";
}

async function readLoginForm(request: Request): Promise<URLSearchParams | null> {
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(decoder.decode(bytes));
}

function commonHeaders(): Headers {
  return new Headers({
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Chalk-Atlas-Build": ATLAS_BUILD_ID,
  });
}

function accessScreen(returnPath: string, options: { message?: string; status?: number } = {}): Response {
  const status = options.status || 401;
  const headers = commonHeaders();
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  headers.set("WWW-Authenticate", 'Chalk-Access-Code realm="Architecture atlas"');
  if (status === 429) headers.set("Retry-After", "60");
  const message = options.message ? `<p class="error" role="alert">${options.message}</p>` : "";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chalk architecture access</title><style>:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#efece5;color:#191919}.card{width:min(92vw,420px);padding:34px;border:1px solid #c9c4b8;border-radius:20px;background:#faf8f3;box-shadow:0 24px 80px #2520181a}.mark{display:inline-grid;place-items:center;width:38px;height:38px;margin-bottom:22px;border-radius:12px;background:#7957d5;color:#fff;font-weight:850;font-size:20px}h1{margin:0 0 9px;font-size:25px;letter-spacing:-.04em}p{margin:0 0 22px;color:#5f5b54;line-height:1.55}.error{padding:10px 12px;border:1px solid #b94b4b;border-radius:9px;color:#8d2929;background:#fff3f3}label{display:block;margin-bottom:7px;font-size:12px;font-weight:750}input,button{width:100%;height:44px;border-radius:10px;font:inherit}input{padding:0 12px;border:1px solid #aaa59a;background:#fff;color:#191919}button{margin-top:12px;border:0;background:#7957d5;color:#fff;font-weight:800;cursor:pointer}small{display:block;margin-top:18px;color:#777168;line-height:1.45}@media(prefers-color-scheme:dark){body{background:#171615;color:#f3efe7}.card{background:#22201e;border-color:#46413b}.card p,.card small{color:#aaa39a}input{background:#171615;border-color:#56504a;color:#f3efe7}}</style></head><body><main class="card"><div class="mark" aria-hidden="true">C</div><h1>Architecture atlas</h1><p>Enter the Chalk access code to continue. Every atlas page and bundled asset requires a signed session.</p>${message}<form method="post" action="/_auth/login"><input type="hidden" name="returnTo" value="${returnPath.replace(/[&<>"']/g, "")}"><label for="accessCode">Access code</label><input id="accessCode" name="accessCode" type="password" autocomplete="current-password" required autofocus><button type="submit">Open atlas</button></form><small>Login attempts are rate limited. Sessions expire after eight hours and are invalidated by each deployment.</small></main></body></html>`;
  return new Response(body, { status, headers });
}

function methodNotAllowed(allow: string): Response {
  const headers = commonHeaders();
  headers.set("Allow", allow);
  headers.set("Cache-Control", "no-store");
  return new Response("Method not allowed", { status: 405, headers });
}

async function login(request: Request, env: Environment): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const crossOriginBrowserRequest = fetchSite && fetchSite !== "same-origin";
  const crossOriginNonBrowserRequest = !fetchSite && origin && origin !== new URL(request.url).origin;
  if (crossOriginBrowserRequest || crossOriginNonBrowserRequest) return accessScreen("/", { message: "Cross-origin login requests are not accepted.", status: 403 });
  if (!env.LOGIN_RATE_LIMITER || !env.ATLAS_ACCESS_CODE_SHA256 || !env.ATLAS_SESSION_SECRET) return accessScreen("/", { message: "Access is temporarily unavailable.", status: 503 });

  const rateLimitKey = request.headers.get("cf-connecting-ip") || "unknown";
  const rateLimit = await env.LOGIN_RATE_LIMITER.limit({ key: rateLimitKey });
  if (!rateLimit.success) return accessScreen("/", { message: "Too many login attempts. Try again in one minute.", status: 429 });

  const form = await readLoginForm(request);
  if (!form) return accessScreen("/", { message: "Invalid or oversized login request.", status: 413 });
  const accessCode = form.get("accessCode");
  const returnPath = safeReturnPath(form.get("returnTo"));
  const suppliedHash = await sha256Hex(typeof accessCode === "string" ? accessCode : "");
  if (!/^[a-f\d]{64}$/i.test(env.ATLAS_ACCESS_CODE_SHA256) || !constantTimeEqual(suppliedHash, env.ATLAS_ACCESS_CODE_SHA256.toLowerCase())) {
    return accessScreen(returnPath, { message: "That access code was not accepted." });
  }

  const headers = commonHeaders();
  headers.set("Location", returnPath);
  headers.set("Cache-Control", "no-store");
  headers.append("Set-Cookie", `${SESSION_COOKIE}=${await createSession(env.ATLAS_SESSION_SECRET)}; Path=/; Max-Age=${SESSION_LIFETIME_SECONDS}; HttpOnly; Secure; SameSite=Strict`);
  return new Response(null, { status: 303, headers });
}

function assetResponse(pathname: string, headOnly: boolean): Response | null {
  const asset = ASSET_RECORDS[pathname as keyof typeof ASSET_RECORDS];
  if (!asset) return null;
  const bytes = Uint8Array.from(atob(asset.base64), (character) => character.charCodeAt(0));
  const headers = commonHeaders();
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  headers.set("Content-Type", asset.contentType);
  headers.set("Content-Length", String(bytes.byteLength));
  headers.set("ETag", `"sha256-${asset.sha256}"`);
  headers.set("X-Content-SHA256", asset.sha256);
  headers.set("Vary", "Cookie");
  return new Response(headOnly ? null : bytes, { headers });
}

function manifestResponse(): Response {
  const headers = commonHeaders();
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  const assets = Object.fromEntries(Object.entries(ASSET_RECORDS).map(([path, asset]) => [path, { source: asset.source, contentType: asset.contentType, sha256: asset.sha256, size: asset.size }]));
  return new Response(JSON.stringify({ buildId: ATLAS_BUILD_ID, assets }), { headers });
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_auth/login") return login(request, env);

    if (!(await hasValidSession(request, env))) return accessScreen(`${url.pathname}${url.search}`);

    if (url.pathname === "/_auth/logout") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const headers = commonHeaders();
      headers.set("Location", "/");
      headers.set("Cache-Control", "no-store");
      headers.append("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      return new Response(null, { status: 303, headers });
    }

    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    if (url.pathname === "/__atlas/manifest") return manifestResponse();
    const asset = assetResponse(url.pathname, request.method === "HEAD");
    if (asset) return asset;
    if (url.pathname !== "/" && url.pathname !== "/architecture.html") return new Response("Not found", { status: 404, headers: commonHeaders() });

    const headers = commonHeaders();
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Security-Policy", ATLAS_CSP);
    headers.set("Vary", "Cookie");
    return new Response(request.method === "HEAD" ? null : ATLAS_HTML, { headers });
  },
};
