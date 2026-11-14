import { z } from "zod";
import type { DashboardBindings, DashboardEnvironment } from "./config";
import { configuration } from "./config";
import type { Authentication, Identity, IdentityProvider } from "./identity";
import { binding, checkCsrf, clearSeatCookies, clearSession, csrfToken, readCookie, seal, setSession, unseal, writeCookie } from "./cookies";
import { sealSession } from "./session";
import { body, form, DashboardError, exactOrigin, json, query, redirect } from "./http";
import { withSessionEngine, resolveTenant } from "./engine";
import { pages, type Context } from "./pages";
import { edgeCache, favicon } from "./favicon";
import { DASHBOARD_RETURN_PATH } from "../src/lib/dashboard/return-path";
import type { SessionDTO } from "../src/lib/dashboard/contracts";

const startQuery = z.strictObject({
  provider: z.enum(["google", "apple"]),
  returnTo: z.string().regex(DASHBOARD_RETURN_PATH).default("/dashboard"),
});
const callbackQuery = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(1024), user: z.string().max(4096).optional() });
const transaction = z.object({ state: z.string(), codeVerifier: z.string(), nonce: z.string(), previous: z.object({ userId: z.string(), name: z.string() }).optional(), returnTo: z.string(), provider: z.enum(["google", "apple"]), expiresAt: z.number() });
const emptyBody = z.strictObject({});
const faviconQuery = z.strictObject({ host: z.string().min(1).max(253) });
async function current(request: Request, env: DashboardEnvironment, provider: IdentityProvider): Promise<Identity> {
  const sealed = readCookie(request, env, "session");
  if (!sealed) throw new DashboardError(401, "sign_in_required");
  const result = await provider.authenticate(sealed);
  if (result.kind !== "authenticated") throw new DashboardError(401, "sign_in_required");
  const bound = await binding(request, env);
  if (bound.userId !== result.identity.userId || bound.sessionId !== result.identity.sessionId) throw new DashboardError(401, "session_binding_mismatch");
  return result.identity;
}
async function sessionDTO(person: Identity, env: DashboardEnvironment): Promise<SessionDTO> {
  return { profile: { id: person.userId, name: person.name, email: person.email, avatarUrl: person.avatarUrl }, csrfToken: await csrfToken(person, env) };
}
type Provider = "google" | "apple";
type AuthContext = { readonly request: Request; readonly env: DashboardEnvironment; readonly provider: IdentityProvider };

async function authStart({ request, env, provider }: AuthContext): Promise<Response> {
  const input = startQuery.parse(query(request));
  const login = await provider.start(input.provider);
  const response = redirect(login.url);
  const existing = readCookie(request, env, "session");
  const authenticated: Authentication = existing ? await provider.authenticate(existing) : { kind: "unauthenticated" };
  const previous = authenticated.kind === "authenticated" && authenticated.identity.provider === input.provider ? { userId: authenticated.identity.userId, name: authenticated.identity.name } : undefined;
  writeCookie(response, env, `login_${input.provider}`, await seal({ state: login.state, codeVerifier: login.codeVerifier, nonce: login.nonce, previous, returnTo: input.returnTo, provider: input.provider, expiresAt: Date.now() + 600000 }, env.SESSION_SECRET, `login_${input.provider}`), 600);
  return response;
}

async function completeSignIn({ request, env, provider }: AuthContext, name: Provider): Promise<Response> {
  if (name === "apple" && request.headers.get("Origin") !== "https://appleid.apple.com") throw new DashboardError(403, "origin_rejected");
  const loginCookie = readCookie(request, env, `login_${name}`);
  if (!loginCookie) throw new DashboardError(400, "login_state_missing");
  const login = transaction.parse(await unseal(loginCookie, env.SESSION_SECRET, `login_${name}`));
  const input = callbackQuery.parse(name === "apple" ? await form(request) : query(request));
  if (login.expiresAt <= Date.now() || login.state !== input.state || login.provider !== name) throw new DashboardError(400, "login_state_rejected");
  const identity = await provider.exchange({ ...input, provider: name, codeVerifier: login.codeVerifier, nonce: login.nonce });
  if (!identity.name && login.previous?.userId === identity.userId) identity.name = login.previous.name;
  if (!identity.name) identity.name = identity.email;
  await resolveTenant(env, identity, true);
  const response = redirect(startQuery.shape.returnTo.parse(login.returnTo));
  await setSession(response, env, await sealSession(identity, env.SESSION_SECRET), identity);
  return response;
}

/** A failed sign-in goes back to the sign-in page, not to a JSON error. The login cookie is spent either way. */
async function authCallback(context: AuthContext, name: Provider): Promise<Response> {
  let response: Response;
  try {
    response = await completeSignIn(context, name);
  } catch (error) {
    const failed = failure(error);
    response = redirect(`/dashboard/sign-in?failed=${name}`);
    response.headers.set("X-Request-ID", failed.headers.get("X-Request-ID") ?? "");
  }
  writeCookie(response, context.env, `login_${name}`, "", 0);
  return response;
}

async function authLeave({ request, env }: AuthContext, signOut: boolean): Promise<Response> {
  exactOrigin(request, env.DASHBOARD_ORIGIN);
  emptyBody.parse(await body(request));
  const bound = await binding(request, env);
  await checkCsrf(request, bound, env);
  const response = json(signOut ? { ok: true, clearLocalBookmarks: true } : { ok: true });
  if (signOut) clearSession(response, env, request);
  else clearSeatCookies(response, request, env);
  return response;
}

async function auth(request: Request, env: DashboardEnvironment, provider: IdentityProvider, path: string): Promise<Response> {
  const context = { request, env, provider };
  const route = `${request.method} ${path}`;
  switch (route) {
    case "GET /auth/start":
      return authStart(context);
    case "GET /auth/callback/google":
      return authCallback(context, "google");
    case "POST /auth/callback/apple":
      return authCallback(context, "apple");
    case "GET /auth/session":
      return json(await sessionDTO(await current(request, env, provider), env));
    case "POST /auth/sign-out":
      return authLeave(context, true);
    case "POST /auth/clear-owner-seats":
      return authLeave(context, false);
    default:
      throw new DashboardError(405, "method_not_allowed");
  }
}
async function dashboard(request: Request, env: DashboardEnvironment, provider: IdentityProvider, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") throw new DashboardError(405, "method_not_allowed");
  if (request.method === "POST") exactOrigin(request, env.DASHBOARD_ORIGIN);
  const person = await current(request, env, provider);
  if (request.method === "POST") await checkCsrf(request, person, env);
  if (request.method === "GET" && path === "/dashboard-api/favicon") return favicon(faviconQuery.parse(query(request)).host, { fetcher: fetch, cache: edgeCache() });
  const name = path.slice("/dashboard-api/".length);
  const page = Object.hasOwn(pages, name) ? pages[name as keyof typeof pages] : undefined;
  if (!page) throw new DashboardError(404, "route_not_found");
  return withSessionEngine(request, env, person, async (engine) => {
    const context: Context = { engine, request, env, person };
    return request.method === "GET" ? page.read(context) : page.act(context, await body(request));
  });
}
function failure(error: unknown): Response {
  const status = error instanceof DashboardError ? error.status : error instanceof z.ZodError ? 400 : 503;
  const code = error instanceof DashboardError ? error.code : error instanceof z.ZodError ? "invalid_request" : "service_unavailable";
  const requestId = crypto.randomUUID();
  console.warn(JSON.stringify({ event: "dashboard.request_failed", request_id: requestId, status, code, error_type: error instanceof Error ? error.name : typeof error }));
  const response = json({ error: status === 429 ? { code, retryable: true, retryAfterSeconds: 60 } : { code } }, status);
  if (status === 429) response.headers.set("Retry-After", "60");
  response.headers.set("X-Request-ID", requestId);
  return response;
}
export async function handleDashboard(request: Request, bindings: DashboardBindings, makeProvider: (env: DashboardEnvironment) => IdentityProvider): Promise<Response> {
  try {
    const env = configuration(bindings);
    if (new URL(request.url).origin !== env.DASHBOARD_ORIGIN) throw new DashboardError(403, "origin_rejected");
    const provider = makeProvider(env);
    const path = new URL(request.url).pathname;
    return path.startsWith("/auth/") ? await auth(request, env, provider, path) : await dashboard(request, env, provider, path);
  } catch (error) {
    return failure(error);
  }
}
