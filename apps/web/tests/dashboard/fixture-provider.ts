import { z } from "zod";
import type { DashboardEnvironment } from "../../server/config";
import type { Identity, IdentityProvider } from "../../server/identity";
import { seal, unseal } from "../../server/cookies";
import { DashboardError, json, redirect } from "../../server/http";

const people = {
  ada: { userId: "fixture_ada", name: "Ada Fixture", email: "ada@example.test", avatarUrl: null },
  malik: { userId: "fixture_malik", name: "Malik Fixture", email: "malik@example.test", avatarUrl: null },
};
const codes = new Map<string, { person: keyof typeof people; challenge: string; expiresAt: number }>();
const sessions = new Map<string, { revoked: boolean; refresh: "success" | "transient" | "terminal"; online: boolean; accessExpiresAt: number }>();
const sessionSchema = z.object({ identity: z.object({ userId: z.string(), sessionId: z.string(), name: z.string(), email: z.string(), avatarUrl: z.null() }), expiresAt: z.number() });
const authorizeSchema = z.object({ state: z.string().min(1), challenge: z.string().min(1), person: z.enum(["ada", "malik"]).optional() });
async function challenge(verifier: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))), (b) => b.toString(16).padStart(2, "0")).join("");
}
function assertLocal(env: DashboardEnvironment): void {
  if (!["local", "test"].includes(env.CHALK_ENVIRONMENT) || env.DASHBOARD_IDENTITY_PROVIDER !== "fixture") throw new Error("Fixture identity is local/test only");
}
export function fixtureProvider(env: DashboardEnvironment): IdentityProvider {
  assertLocal(env);
  const load = async (sealed: string) => sessionSchema.parse(await unseal(sealed, env.WORKOS_COOKIE_PASSWORD, "fixture-identity"));
  const makeSession = async (identity: Identity) => seal({ identity, accessToken: "fixture-workos-access-token-not-for-browser", refreshToken: "fixture-workos-refresh-token-not-for-browser", expiresAt: Date.now() + 300000 }, env.WORKOS_COOKIE_PASSWORD, "fixture-identity");
  return {
    async start() {
      const state = crypto.randomUUID();
      const codeVerifier = crypto.randomUUID();
      return { state, codeVerifier, url: `${env.DASHBOARD_ORIGIN}/fixture/authorize?${new URLSearchParams({ state, challenge: await challenge(codeVerifier) })}` };
    },
    async exchange(code, codeVerifier) {
      const issued = codes.get(code);
      codes.delete(code);
      if (!issued || issued.expiresAt < Date.now() || issued.challenge !== (await challenge(codeVerifier))) throw new DashboardError(401, "fixture_code_rejected");
      const identity = { ...people[issued.person], sessionId: crypto.randomUUID() };
      fixtureSessionPeople.set(identity.sessionId, issued.person);
      sessions.set(identity.sessionId, { revoked: false, online: true, accessExpiresAt: Date.now() + 300000, refresh: "success" });
      return { identity, sealedSession: await makeSession(identity) };
    },
    async authenticate(sealed) {
      try {
        const result = await load(sealed);
        if (result.expiresAt <= Date.now() || (sessions.get(result.identity.sessionId)?.accessExpiresAt ?? 0) <= Date.now()) return { kind: "unauthenticated" };
        return { kind: "authenticated", identity: result.identity };
      } catch {
        return { kind: "unauthenticated" };
      }
    },
    async refresh(sealed) {
      const result = await load(sealed);
      const session = sessions.get(result.identity.sessionId);
      if (!session || session.revoked || session.refresh === "terminal") return { kind: "terminal" };
      if (session.refresh === "transient") return { kind: "transient" };
      session.accessExpiresAt = Date.now() + 300000;
      return { kind: "refreshed", identity: result.identity, sealedSession: await makeSession(result.identity) };
    },
    async online(identity) {
      const session = sessions.get(identity.sessionId);
      return !!session && !session.revoked && session.online;
    },
    async revoke(identity) {
      const session = sessions.get(identity.sessionId);
      if (session) session.revoked = true;
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
    codes.set(code, { person: input.person, challenge: input.challenge, expiresAt: Date.now() + 60000 });
    return redirect(`${env.WORKOS_REDIRECT_URI}?${new URLSearchParams({ code, state: input.state })}`);
  }
  if (request.method === "POST" && url.pathname === "/fixture/control") {
    const input = z.strictObject({ person: z.enum(["ada", "malik"]), online: z.boolean().optional(), expire: z.boolean().optional(), refresh: z.enum(["success", "transient", "terminal"]).optional() }).parse(await request.json());
    // Fixture identities are deterministic; controls apply only to sessions this local isolate issued.
    for (const [id, session] of sessions) {
      const target = fixtureSessionPeople.get(id);
      if (target === input.person) {
        if (input.online !== undefined) session.online = input.online;
        if (input.expire) session.accessExpiresAt = 0;
        if (input.refresh) session.refresh = input.refresh;
      }
    }
    return json({ ok: true });
  }
  return json({ error: { code: "route_not_found" } }, 404);
}
const fixtureSessionPeople = new Map<string, keyof typeof people>();
