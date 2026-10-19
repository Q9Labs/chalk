import { z } from "zod";
import type { DashboardEnvironment } from "./config";
import type { IdentityProvider, Provider } from "./identity";
import { DashboardError } from "./http";
import { authenticate, SESSION_SECONDS } from "./session";

const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}
function random(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function challenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}
const providers = {
  google: { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", jwks: "https://www.googleapis.com/oauth2/v3/certs", issuers: ["https://accounts.google.com", "accounts.google.com"] },
  apple: { authorize: "https://appleid.apple.com/auth/authorize", token: "https://appleid.apple.com/auth/token", jwks: "https://appleid.apple.com/auth/keys", issuers: ["https://appleid.apple.com"] },
};
const headerSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) });
const claimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  azp: z.string().optional(),
  sub: z.string().min(1).max(255),
  iat: z.number(),
  exp: z.number(),
  nonce: z.string(),
  email: z.string().max(320).optional(),
  email_verified: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  name: z.string().max(512).optional(),
  picture: z.url().optional(),
});
const jwksSchema = z.object({ keys: z.array(z.object({ kty: z.literal("RSA"), kid: z.string(), n: z.string(), e: z.string(), alg: z.literal("RS256").optional(), use: z.literal("sig").optional() })) });
const rejectionSchema = z.object({ error: z.enum(["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "access_denied", "server_error", "temporarily_unavailable"]) });
async function fetchJson(url: string, init?: RequestInit, provider: Provider | "jwks" = "jwks"): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    let reason = "unrecognized_error_response";
    try {
      const rejection = rejectionSchema.safeParse(await response.json());
      if (rejection.success) reason = rejection.data.error;
    } catch {
      reason = "unreadable_error_response";
    }
    throw new DashboardError(502, `identity_${provider}_${response.status}_${reason}`);
  }
  return response.json();
}
export async function verifyIdToken(input: { token: string; clientId: string; nonce: string; issuers: string[]; jwks: string }): Promise<z.infer<typeof claimsSchema>> {
  const [headerPart, payload, signature, extra] = input.token.split(".");
  if (!headerPart || !payload || !signature || extra || input.token.length > 16384) throw new DashboardError(401, "id_token_rejected");
  const header = headerSchema.parse(JSON.parse(new TextDecoder().decode(decode(headerPart))));
  const jwks = jwksSchema.parse(await fetchJson(input.jwks));
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) throw new DashboardError(401, "id_token_rejected");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(signature), encoder.encode(`${headerPart}.${payload}`)))) throw new DashboardError(401, "id_token_rejected");
  const claims = claimsSchema.parse(JSON.parse(new TextDecoder().decode(decode(payload))));
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (
    !input.issuers.includes(claims.iss) ||
    !audiences.includes(input.clientId) ||
    (audiences.length > 1 && claims.azp !== input.clientId) ||
    (claims.azp !== undefined && claims.azp !== input.clientId) ||
    claims.exp <= Date.now() / 1000 ||
    claims.iat > Date.now() / 1000 + 60 ||
    claims.iat > claims.exp ||
    claims.nonce !== input.nonce
  )
    throw new DashboardError(401, "id_token_rejected");
  return claims;
}
export async function appleClientSecret(env: Pick<DashboardEnvironment, "APPLE_TEAM_ID" | "APPLE_SERVICES_ID" | "APPLE_KEY_ID" | "APPLE_PRIVATE_KEY">): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: env.APPLE_KEY_ID, typ: "JWT" })));
  // Short-lived secrets avoid a stored JWT and stay below Apple's six-month limit.
  const claims = base64url(encoder.encode(JSON.stringify({ iss: env.APPLE_TEAM_ID, sub: env.APPLE_SERVICES_ID, aud: "https://appleid.apple.com", iat: now, exp: now + 300 })));
  const pem = env.APPLE_PRIVATE_KEY.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", decode(pem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`));
  return `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
}
const appleUser = z.object({ name: z.object({ firstName: z.string().max(256).optional(), lastName: z.string().max(256).optional() }).optional() });
export function oauthProvider(env: DashboardEnvironment): IdentityProvider {
  const clientId = (provider: Provider) => (provider === "google" ? env.GOOGLE_CLIENT_ID : env.APPLE_SERVICES_ID);
  const callback = (provider: Provider) => `${env.DASHBOARD_ORIGIN}/auth/callback/${provider}`;
  return {
    async start(provider) {
      const state = random(),
        codeVerifier = random(),
        nonce = random();
      const url = new URL(providers[provider].authorize);
      const params = new URLSearchParams({ client_id: clientId(provider), redirect_uri: callback(provider), response_type: "code", state, nonce, scope: provider === "google" ? "openid email profile" : "name email" });
      if (provider === "google") {
        params.set("code_challenge", await challenge(codeVerifier));
        params.set("code_challenge_method", "S256");
      } else params.set("response_mode", "form_post");
      url.search = params.toString();
      return { url: url.href, state, codeVerifier, nonce };
    },
    async exchange(input) {
      const config = providers[input.provider];
      const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code, client_id: clientId(input.provider), redirect_uri: callback(input.provider), client_secret: input.provider === "google" ? env.GOOGLE_CLIENT_SECRET : await appleClientSecret(env) });
      if (input.provider === "google") body.set("code_verifier", input.codeVerifier);
      const response = z.object({ id_token: z.string() }).parse(await fetchJson(config.token, { method: "POST", body }, input.provider));
      const claims = await verifyIdToken({ token: response.id_token, clientId: clientId(input.provider), nonce: input.nonce, issuers: config.issuers, jwks: config.jwks });
      const name = input.provider === "apple" && input.user ? appleUser.parse(JSON.parse(input.user)).name : undefined;
      return {
        provider: input.provider,
        userId: claims.sub,
        sessionId: crypto.randomUUID(),
        name: name ? [name.firstName, name.lastName].filter(Boolean).join(" ") : (claims.name ?? ""),
        email: input.provider === "google" && claims.email_verified !== true ? "" : (claims.email ?? ""),
        avatarUrl: input.provider === "google" ? (claims.picture ?? null) : null,
        expiresAt: Date.now() + SESSION_SECONDS * 1000,
      };
    },
    authenticate: (sealed) => authenticate(sealed, env.SESSION_SECRET),
  };
}
