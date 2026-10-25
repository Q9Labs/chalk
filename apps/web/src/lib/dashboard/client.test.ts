import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { readonly url: string; readonly method: string; readonly csrf: string | null };

const json = (status: number, body: object, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const profile = { name: "June Park", email: "june@example.com", avatarUrl: null };

/** A fresh client module per test, so its CSRF token starts empty. */
async function client(replies: readonly Response[]) {
  vi.resetModules();
  const calls: Call[] = [];
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", csrf: new Headers(init.headers).get("X-CSRF-Token") });
      const reply = queue.shift();
      if (!reply) throw new Error(`no reply for ${url}`);
      return reply;
    }),
  );
  return { module: await import("./client"), calls };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("dashboard client", () => {
  it("builds the provider sign-in URL and refuses a return path outside the dashboard", async () => {
    const { module } = await client([]);
    expect(module.signInURL("google", "/dashboard/call/abc")).toBe("/auth/start?provider=google&returnTo=%2Fdashboard%2Fcall%2Fabc");
    expect(module.signInURL("apple", "https://evil.example/dashboard")).toBe("/auth/start?provider=apple&returnTo=%2Fdashboard");
  });

  it("sends the session's CSRF token with every action", async () => {
    const { module, calls } = await client([json(200, { profile, csrfToken: "token-1" }), json(200, { ok: true })]);
    await module.act("developer", { action: "revoke-key", keyId: "00000000-0000-4000-8000-000000000001" });
    expect(calls).toEqual([
      { url: "/auth/session", method: "GET", csrf: null },
      { url: "/dashboard-api/developer", method: "POST", csrf: "token-1" },
    ]);
  });

  it("requires sign-in for an expired session without refreshing or retrying", async () => {
    const { module, calls } = await client([json(401, { error: { code: "sign_in_required" } })]);
    const failure = await module.readPage("home", {}).catch((error: unknown) => error);
    expect(module.needsSignIn(failure)).toBe(true);
    expect(calls).toEqual([{ url: "/dashboard-api/home", method: "GET", csrf: null }]);
  });

  it("sends a signed-out person to sign in", async () => {
    const { module } = await client([json(401, { error: { code: "sign_in_required" } })]);
    const failure = await module.loadSession().catch((error: unknown) => error);
    expect(module.needsSignIn(failure)).toBe(true);
  });

  it("says how long to wait when the engine is rate limiting", async () => {
    const { module } = await client([json(429, { error: { code: "engine_rate_limited", retryable: true, retryAfterSeconds: 60 } }, { "Retry-After": "60" })]);
    const failure = await module.readPage("developer", {}).catch((error: unknown) => error);
    expect(module.needsSignIn(failure)).toBe(false);
    expect(module.errorMessage(failure)).toBe("Chalk is getting a lot of requests. Try again in 60 seconds.");
  });

  it("honours an HTTP-date Retry-After header ahead of a body hint", async () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { module } = await client([json(429, { error: { code: "engine_rate_limited", retryAfterSeconds: 5 } }, { "Retry-After": "Wed, 21 Oct 2026 12:01:00 GMT" })]);
      await expect(module.readPage("developer", {})).rejects.toMatchObject({ retryAfterSeconds: 60 });
    } finally {
      clock.mockRestore();
    }
  });

  it("shows the expiry policy instead of a retry toast", async () => {
    const { module } = await client([json(400, { error: { code: "api_key_invalid_expiry" } })]);
    const failure = await module.readPage("developer", {}).catch((error: unknown) => error);
    expect(module.failureKind(failure)).toBe("terminal");
    expect(module.errorMessage(failure)).toBe("API key expiry must be in the future and no more than 365 days from now.");
  });

  it("asks for a fresh sign-in before a sensitive change", async () => {
    const { module } = await client([json(200, { profile, csrfToken: "t" }), json(401, { error: { code: "fresh_sign_in_required" } })]);
    const failure = await module.act("developer", { action: "revoke-key", keyId: "00000000-0000-4000-8000-000000000001" }).catch((error: unknown) => error);
    expect(module.errorMessage(failure)).toBe("Sign in again to make this change. It keeps your account safe.");
  });
});
