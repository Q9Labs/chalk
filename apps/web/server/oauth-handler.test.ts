/// <reference types="node" />
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { handleDashboard } from "./application";
import { configuration } from "./config";
import { base64url, oauthProvider } from "./oauth";
import type { Provider } from "./identity";

const encoder = new TextEncoder();
const nativeFetch = globalThis.fetch;
let signingKey: CryptoKey;
let publicKey: JsonWebKey;
let serverOrigin: string;
let appleKey: string;
const exchanges: URLSearchParams[] = [];
const codes = new Map<string, { provider: Provider; nonce: string; claims: object }>();
async function idToken(provider: Provider, nonce: string, claims: object): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid: "handler-key" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(encoder.encode(JSON.stringify({ iss: provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com", aud: `${provider}-client`, sub: "subject", nonce, iat: now, exp: now + 300, email: "person@example.test", email_verified: true, ...claims })));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname.endsWith("/keys")) {
    response.setHeader("Cache-Control", "max-age=60");
    response.end(JSON.stringify({ keys: [{ ...publicKey, kid: "handler-key", alg: "RS256", use: "sig" }] }));
    return;
  }
  if (url.pathname.endsWith("/token")) {
    let body = "";
    for await (const part of request) body += part;
    const params = new URLSearchParams(body);
    exchanges.push(params);
    const code = params.get("code") ?? "";
    const login = codes.get(code);
    codes.delete(code);
    if (!login) {
      response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    response.end(JSON.stringify({ id_token: await idToken(login.provider, login.nonce, login.claims) }));
    return;
  }
  if (url.pathname === "/v1/tenants/by-external-id") {
    response.end(
      JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        name: "Personal",
        external_id: url.searchParams.get("external_id"),
        cors_allowed_origins: [],
        default_media_plane: null,
        media_plane_provider_config: null,
        storage_provider_config: null,
        logo_key: null,
        website: null,
        transcription_ceiling: "on_demand",
        transcription_default_mode: "on_demand",
        provider_policy_version: "test",
        recording_retention_seconds: 3600,
        transcript_retention_seconds: 3600,
        transcription_source_window_seconds: 3600,
        created_at: "2026-10-18T12:00:00Z",
        updated_at: "2026-10-18T12:00:00Z",
      }),
    );
    return;
  }
  response.writeHead(404).end("{}");
});
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  signingKey = keys.privateKey;
  publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const apple = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  appleKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", apple.privateKey))))}\n-----END PRIVATE KEY-----`;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture");
  serverOrigin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.close();
  await once(server, "close");
});
beforeEach(() => {
  exchanges.length = 0;
  codes.clear();
  // Only external HTTP is redirected. The handler, OAuth adapter, crypto, cookies,
  // and generated engine client all run unchanged against real local HTTP servers.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const targets: Record<string, string> = {
      "https://oauth2.googleapis.com/token": "/google/token",
      "https://www.googleapis.com/oauth2/v3/certs": "/google/keys",
      "https://appleid.apple.com/auth/token": "/apple/token",
      "https://appleid.apple.com/auth/keys": "/apple/keys",
    };
    const target = targets[url.href];
    if (target) return nativeFetch(`${serverOrigin}${target}`, { method: request.method, headers: request.headers, body: request.method === "POST" ? await request.text() : undefined, signal: request.signal });
    if (url.origin !== serverOrigin) throw new Error("Unexpected external HTTP request");
    return nativeFetch(request);
  });
});
afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());
function env() {
  return configuration({
    CHALK_ENVIRONMENT: "test",
    CHALK_API_ORIGIN: serverOrigin,
    DASHBOARD_ORIGIN: "http://localhost:8788",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    APPLE_SERVICES_ID: "apple-client",
    APPLE_TEAM_ID: "TEAM123456",
    APPLE_KEY_ID: "KEY1234567",
    APPLE_PRIVATE_KEY: appleKey,
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    DASHBOARD_SERVICE_TOKEN: "fixture-service",
    DASHBOARD_IDENTITY_PROVIDER: "oauth",
  });
}
async function start(provider: Provider) {
  const response = await handleDashboard(new Request(`${env().DASHBOARD_ORIGIN}/auth/start?provider=${provider}`), env(), oauthProvider);
  const url = new URL(response.headers.get("Location") ?? "");
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error("Missing transaction cookie");
  const code = crypto.randomUUID();
  codes.set(code, { provider, nonce: url.searchParams.get("nonce") ?? "", claims: {} });
  return { provider, url, cookie, code };
}
function callback(login: Awaited<ReturnType<typeof start>>, user?: string) {
  const params = new URLSearchParams({ code: login.code, state: login.url.searchParams.get("state") ?? "" });
  if (user !== undefined) params.set("user", user);
  const url = `${env().DASHBOARD_ORIGIN}/auth/callback/${login.provider}`;
  const request = login.provider === "apple" ? new Request(url, { method: "POST", headers: { Cookie: login.cookie, Origin: "https://appleid.apple.com", "Content-Type": "application/x-www-form-urlencoded" }, body: params }) : new Request(`${url}?${params}`, { headers: { Cookie: login.cookie } });
  return handleDashboard(request, env(), oauthProvider);
}
it("never logs raw Apple user input after verifying a signed ID token", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const response = await callback(await start("apple"), "\nMARKER");
  expect(exchanges).toHaveLength(1);
  expect(response.headers.get("Location")).toBe("/dashboard/sign-in?failed=apple");
  expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("local_chalk_session="))).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain("MARKER");
  expect(JSON.parse(warn.mock.calls[0]?.[0])).toMatchObject({ event: "dashboard.request_failed", code: "service_unavailable", request_id: expect.any(String), error_type: "SyntaxError" });
});

it.each([
  ["google", true, "person@example.test"],
  ["google", false, ""],
  ["google", undefined, ""],
  ["google", "true", ""],
  ["apple", "true", "person@example.test"],
] as const)("keeps %s email only with the appropriate verification metadata %s", async (provider, verified, email) => {
  const login = await start(provider);
  const code = codes.get(login.code);
  if (!code) throw new Error("Missing authorization code");
  code.claims = { email_verified: verified };
  const response = await callback(login);
  expect(response.headers.get("Location")).toBe("/dashboard");
  const cookies = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const session = await handleDashboard(new Request(`${env().DASHBOARD_ORIGIN}/auth/session`, { headers: { Cookie: cookies } }), env(), oauthProvider);
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ profile: { email } });
});
