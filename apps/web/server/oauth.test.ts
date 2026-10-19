/// <reference types="node" />
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { appleClientSecret, base64url, challenge, oauthProvider, verifyIdToken } from "./oauth";
import { configuration } from "./config";

const encoder = new TextEncoder();
const env = configuration({
  CHALK_ENVIRONMENT: "test",
  CHALK_API_ORIGIN: "http://localhost:8080",
  DASHBOARD_ORIGIN: "http://localhost:8788",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  APPLE_SERVICES_ID: "apple-client",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_KEY_ID: "KEY1234567",
  APPLE_PRIVATE_KEY: "replaced-in-test",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  DASHBOARD_SERVICE_TOKEN: "fixture-service",
  DASHBOARD_IDENTITY_PROVIDER: "oauth",
});
let keyPair: CryptoKeyPair;
let wrongKey: CryptoKeyPair;
let jwksUrl: string;
let publicKey: JsonWebKey;
const jwksRequests = new Map<string, number>();
const fixtures = new Map<string, { body: string; cacheControl: string; status?: number }>();
const server = createServer((request, response) => {
  const path = request.url ?? "/jwks";
  jwksRequests.set(path, (jwksRequests.get(path) ?? 0) + 1);
  const fixture = fixtures.get(path);
  response.writeHead(fixture?.status ?? 200, { "Content-Type": "application/json", "Cache-Control": fixture?.cacheControl ?? "max-age=300" });
  const body = fixture?.body ?? JSON.stringify({ keys: [{ ...publicKey, kid: "fixture-key", alg: "RS256", use: "sig" }] });
  // Chunked responses exercise the stream limit without Content-Length.
  response.write(body.slice(0, 32768));
  response.end(body.slice(32768));
});
beforeAll(async () => {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keyPair = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  wrongKey = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture");
  jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
});
afterAll(async () => {
  server.close();
  await once(server, "close");
});
async function token(issuer: string, changes = {}, key = keyPair.privateKey, kid = "fixture-key"): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid })));
  const payload = base64url(encoder.encode(JSON.stringify({ iss: issuer, aud: "client", sub: "subject", nonce: "nonce", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, email: "person@example.test", ...changes })));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}
describe.each(["https://accounts.google.com", "https://appleid.apple.com"])("ID token from %s", (issuer) => {
  const verify = (value: string) => verifyIdToken({ token: value, clientId: "client", nonce: "nonce", issuers: [issuer], jwks: jwksUrl });
  it("verifies a real signature through the local JWKS HTTP fixture", async () => {
    expect((await verify(await token(issuer))).sub).toBe("subject");
  });
  it("allows at most sixty seconds of issuance clock skew", async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect((await verify(await token(issuer, { iat: now / 1000 + 60 }))).sub).toBe("subject");
      await expect(verify(await token(issuer, { iat: now / 1000 + 61 }))).rejects.toThrow("id_token_rejected");
    } finally {
      clock.mockRestore();
    }
  });
  it("rejects a bad signature", async () => {
    await expect(verify(await token(issuer, {}, wrongKey.privateKey))).rejects.toThrow();
  });
  it.each([
    { aud: "wrong" },
    { iss: "https://evil.example" },
    { exp: 1 },
    { exp: "later" },
    { iat: undefined },
    { iat: "now" },
    { iat: Math.floor(Date.now() / 1000) + 3600 },
    { iat: Math.floor(Date.now() / 1000) + 30, exp: Math.floor(Date.now() / 1000) + 10 },
    { nonce: "wrong" },
    { aud: ["client", "other"] },
    { azp: "other" },
  ])("rejects altered claims %j", async (changes) => {
    await expect(verify(await token(issuer, changes))).rejects.toThrow();
  });
});
it("signs a verifiable Apple client-secret JWT with the required header and bounded claims", async () => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  const secret = await appleClientSecret({ ...env, APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----` });
  const [header, payload, signature] = secret.split(".");
  if (!header || !payload || !signature) throw new Error("Malformed client secret");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  expect(claims).toMatchObject({ iss: env.APPLE_TEAM_ID, sub: env.APPLE_SERVICES_ID, aud: "https://appleid.apple.com" });
  expect(claims.iat).toBeLessThanOrEqual(Date.now() / 1000);
  expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(15777000);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, keys.publicKey, Uint8Array.from(Buffer.from(signature, "base64url")), encoder.encode(`${header}.${payload}`))).toBe(true);
});
it("starts Google with S256 PKCE and Apple with form_post, both with state and nonce", async () => {
  const provider = oauthProvider(env);
  for (const name of ["google", "apple"] as const) {
    const login = await provider.start(name);
    const url = new URL(login.url);
    expect(url.searchParams.get("state")).toBe(login.state);
    expect(url.searchParams.get("nonce")).toBe(login.nonce);
    expect(url.searchParams.get("redirect_uri")).toBe(`${env.DASHBOARD_ORIGIN}/auth/callback/${name}`);
    if (name === "google") {
      expect(url.searchParams.get("scope")).toBe("openid email profile");
      expect(url.searchParams.get("code_challenge")).toBe(await challenge(login.codeVerifier));
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    } else {
      expect(url.searchParams.get("scope")).toBe("name email");
      expect(url.searchParams.get("response_mode")).toBe("form_post");
    }
  }
});

it("retains bounded provider rejection evidence without exposing arbitrary response text", async () => {
  for (const [body, reason] of [
    [{ error: "invalid_grant", error_description: "sensitive-code" }, "invalid_grant"],
    [{ error: "sensitive-code" }, "unrecognized_error_response"],
  ] as const) {
    vi.stubGlobal("fetch", async () => Response.json(body, { status: 400 }));
    try {
      await expect(oauthProvider(env).exchange({ provider: "google", code: "code", codeVerifier: "verifier", nonce: "nonce" })).rejects.toThrow(`identity_google_400_${reason}`);
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

it.each(["max-age=2", "max-age=7200", "no-store", "no-cache", "max-age=0"])("honors bounded JWKS caching for %s", async (control) => {
  const path = `/cache-${crypto.randomUUID()}`;
  const jwks = new URL(path, jwksUrl).href;
  fixtures.set(path, { body: JSON.stringify({ keys: [{ ...publicKey, kid: "fixture-key" }] }), cacheControl: control });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const verify = (value: string) => verifyIdToken({ token: value, clientId: "client", nonce: "nonce", issuers: ["issuer"], jwks });
  try {
    const value = await token("issuer");
    await Promise.all([verify(value), verify(value), verify(value)]);
    expect(jwksRequests.get(path)).toBe(1); // Concurrent cold loads share one fetch.
    await verify(value);
    const cacheable = control.startsWith("max-age=") && control !== "max-age=0";
    expect(jwksRequests.get(path)).toBe(cacheable ? 1 : 2);
    if (cacheable) {
      clock.mockReturnValue(now + (control === "max-age=2" ? 2001 : 3600001));
      await verify(await token("issuer"));
      expect(jwksRequests.get(path)).toBe(2);
    }
  } finally {
    clock.mockRestore();
  }
});
it("refreshes unknown kids once for rotation and rate-bounds subsequent unknown-kid refreshes", async () => {
  const path = `/rotation-${crypto.randomUUID()}`;
  const jwks = new URL(path, jwksUrl).href;
  const verify = (value: string) => verifyIdToken({ token: value, clientId: "client", nonce: "nonce", issuers: ["issuer"], jwks });
  fixtures.set(path, { body: JSON.stringify({ keys: [{ ...publicKey, kid: "fixture-key" }] }), cacheControl: "max-age=300" });
  await verify(await token("issuer"));
  const rotated = await crypto.subtle.exportKey("jwk", wrongKey.publicKey);
  fixtures.set(path, { body: JSON.stringify({ keys: [{ ...rotated, kid: "rotated-key" }] }), cacheControl: "max-age=300" });
  await verify(await token("issuer", {}, wrongKey.privateKey, "rotated-key"));
  expect(jwksRequests.get(path)).toBe(2);
  await expect(verify(await token("issuer", {}, keyPair.privateKey, "unknown-a"))).rejects.toThrow("id_token_rejected");
  await expect(verify(await token("issuer", {}, keyPair.privateKey, "unknown-b"))).rejects.toThrow("id_token_rejected");
  expect(jwksRequests.get(path)).toBe(2);
});
it.each([200, 400])("bounds streamed JWKS bodies, including HTTP %s responses", async (status) => {
  const path = `/oversized-${status}`;
  fixtures.set(path, { body: " ".repeat(65537), cacheControl: "max-age=300", status });
  await expect(verifyIdToken({ token: await token("issuer"), clientId: "client", nonce: "nonce", issuers: ["issuer"], jwks: new URL(path, jwksUrl).href })).rejects.toThrow("identity_response_too_large");
});
