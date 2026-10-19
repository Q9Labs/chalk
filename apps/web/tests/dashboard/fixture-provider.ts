import { z } from "zod";
import type { DashboardEnvironment } from "../../server/config";
import type { IdentityProvider, Provider } from "../../server/identity";
import { authenticate, SESSION_SECONDS } from "../../server/session";
import { challenge } from "../../server/oauth";
import { DashboardError, json, redirect } from "../../server/http";

const people = {
  ada: { userId: "fixture_ada", name: "Ada Fixture", email: "ada@example.test", avatarUrl: null },
  malik: { userId: "fixture_malik", name: "Malik Fixture", email: "malik@example.test", avatarUrl: null },
};
const codes = new Map<string, { person: keyof typeof people; challenge: string; nonce: string; provider: Provider; expiresAt: number }>();
const expired = new Set<string>();
const issuedSessions = new Map<string, string>();
const authorizeSchema = z.object({ state: z.string().min(1), challenge: z.string().min(1), nonce: z.string().min(1), provider: z.enum(["google", "apple"]), person: z.enum(["ada", "malik"]).optional() });
function assertLocal(env: DashboardEnvironment): void {
  if (!["local", "test"].includes(env.CHALK_ENVIRONMENT) || env.DASHBOARD_IDENTITY_PROVIDER !== "fixture") throw new Error("Fixture identity is local/test only");
}
export function fixtureProvider(env: DashboardEnvironment): IdentityProvider {
  assertLocal(env);
  return {
    async start(provider) {
      const state = crypto.randomUUID(),
        codeVerifier = crypto.randomUUID(),
        nonce = crypto.randomUUID();
      return { state, codeVerifier, nonce, url: `${env.DASHBOARD_ORIGIN}/fixture/authorize?${new URLSearchParams({ state, nonce, provider, challenge: await challenge(codeVerifier) })}` };
    },
    async exchange(input) {
      const issued = codes.get(input.code);
      codes.delete(input.code);
      if (!issued || issued.expiresAt < Date.now() || issued.provider !== input.provider || issued.nonce !== input.nonce || (input.provider === "google" && issued.challenge !== (await challenge(input.codeVerifier)))) throw new DashboardError(401, "fixture_code_rejected");
      const identity = { ...people[issued.person], provider: input.provider, sessionId: crypto.randomUUID(), expiresAt: Date.now() + SESSION_SECONDS * 1000 };
      issuedSessions.set(identity.sessionId, issued.person);
      return identity;
    },
    async authenticate(sealed) {
      const result = await authenticate(sealed, env.SESSION_SECRET);
      if (result.kind === "authenticated" && expired.has(result.identity.sessionId)) return { kind: "unauthenticated" };
      return result;
    },
  };
}
export async function fixtureRoute(request: Request, env: DashboardEnvironment): Promise<Response> {
  assertLocal(env);
  const url = new URL(request.url);
  if (url.pathname === "/fixture/runtime-check") {
    const results: { mode: string; result: string }[] = [];
    for (const mode of ["error", "manual"] as const) {
      try {
        const result = await fetch(`${env.CHALK_API_ORIGIN}/runtime-probe`, { redirect: mode, signal: AbortSignal.timeout(15000) });
        results.push({ mode, result: `${result.status}` });
      } catch (error) {
        results.push({ mode, result: error instanceof Error ? error.message : "unknown" });
      }
    }
    return json(results);
  }
  if (url.pathname === "/fixture/authorize") {
    const input = authorizeSchema.parse(Object.fromEntries(url.searchParams));
    if (!input.person) {
      return new Response(`<a href="?${new URLSearchParams({ ...input, person: "ada" })}">Ada</a><a href="?${new URLSearchParams({ ...input, person: "malik" })}">Malik</a>`, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
    }
    const code = crypto.randomUUID();
    codes.set(code, { person: input.person, challenge: input.challenge, nonce: input.nonce, provider: input.provider, expiresAt: Date.now() + 60000 });
    // The harness submits Apple's returned fields as a cross-site form POST.
    return redirect(`${env.DASHBOARD_ORIGIN}/auth/callback/${input.provider}?${new URLSearchParams({ code, state: input.state })}`);
  }
  if (request.method === "POST" && url.pathname === "/fixture/control") {
    const input = z.strictObject({ person: z.enum(["ada", "malik"]), expire: z.literal(true) }).parse(await request.json());
    for (const [sessionId, person] of issuedSessions) if (person === input.person) expired.add(sessionId);
    return json({ ok: true });
  }
  return json({ error: { code: "route_not_found" } }, 404);
}
