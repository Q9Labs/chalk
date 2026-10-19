import { expect, it } from "vitest";
import { authenticate, sealSession, SESSION_SECONDS } from "./session";
import { configuration } from "./config";
import { writeCookie } from "./cookies";
import type { Identity } from "./identity";
const secret = "a-session-secret-with-at-least-32-characters";
const identity: Identity = { provider: "google", userId: "subject", sessionId: "session", name: "Person", email: "person@example.test", avatarUrl: null, expiresAt: Date.now() + SESSION_SECONDS * 1000 };
it("seals identity without provider tokens and rejects expiry, modification, and key rotation", async () => {
  const sealed = await sealSession(identity, secret);
  expect(sealed).not.toContain(identity.email);
  expect(await authenticate(sealed, secret)).toEqual({ kind: "authenticated", identity });
  expect(await authenticate(await sealSession({ ...identity, expiresAt: Date.now() - 1 }, secret), secret)).toEqual({ kind: "unauthenticated" });
  expect(await authenticate(sealed + "tampered", secret)).toEqual({ kind: "unauthenticated" });
  expect(await authenticate(sealed, secret + "rotated")).toEqual({ kind: "unauthenticated" });
});

it("permits cross-site delivery only for the HTTPS Apple login cookie", () => {
  const env = configuration({
    CHALK_ENVIRONMENT: "staging",
    CHALK_API_ORIGIN: "https://api.example.test",
    DASHBOARD_ORIGIN: "https://staging.chalkmeet.com",
    GOOGLE_CLIENT_ID: "google",
    GOOGLE_CLIENT_SECRET: "secret",
    APPLE_SERVICES_ID: "apple",
    APPLE_TEAM_ID: "team",
    APPLE_KEY_ID: "key",
    APPLE_PRIVATE_KEY: "key",
    SESSION_SECRET: secret,
    DASHBOARD_SERVICE_TOKEN: "service",
    DASHBOARD_IDENTITY_PROVIDER: "oauth",
  });
  for (const purpose of ["session", "binding", "login_google", "login_apple"] as const) {
    const response = new Response();
    writeCookie(response, env, purpose, "sealed");
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toContain(`__Host-chalk_${purpose}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain(`SameSite=${purpose === "login_apple" ? "None" : "Lax"}`);
  }
});
