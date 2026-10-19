import { z } from "zod";
import type { DashboardBindings, DashboardEnvironment } from "./config";
import { configuration } from "./config";
import type { Authentication, Identity, IdentityProvider } from "./identity";
import { binding, checkCsrf, clearSession, csrfToken, readCookie, seal, setSession, unseal, writeCookie } from "./cookies";
import { sealSession } from "./session";
import { body, form, DashboardError, exactOrigin, json, redirect } from "./http";
import { engine, resolveTenant } from "./engine";
import { homeMutation, homePage } from "./home";
import { ownerAccess, viewerSeat } from "./owner-access";
import { callMutation, callPage } from "./call";
import { pastMutation, pastSessionPage } from "./past-session";
import { developerMutation, developerPage } from "./developer";
import { callAction, callQuery, developerAction, developerQuery, homeAction, pageQuery, pastAction, pastQuery } from "../src/lib/dashboard/contracts";
import type { SessionDTO } from "../src/lib/dashboard/contracts";

const startQuery = z.strictObject({
  provider: z.enum(["google", "apple"]),
  returnTo: z
    .string()
    .regex(/^\/dashboard(?:\/[a-zA-Z0-9/_-]*)?$/)
    .default("/dashboard"),
});
const callbackQuery = z.object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(1024), user: z.string().max(4096).optional() });
const transaction = z.object({ state: z.string(), codeVerifier: z.string(), nonce: z.string(), previous: z.object({ userId: z.string(), name: z.string() }).optional(), returnTo: z.string(), provider: z.enum(["google", "apple"]), expiresAt: z.number() });
const emptyBody = z.strictObject({});
function query(request: Request): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(values, key)) throw new DashboardError(400, "duplicate_parameter");
    values[key] = value;
  }
  return values;
}
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
  return { profile: { name: person.name, email: person.email, avatarUrl: person.avatarUrl }, csrfToken: await csrfToken(person, env) };
}
async function auth(request: Request, env: DashboardEnvironment, provider: IdentityProvider, path: string): Promise<Response> {
  if (request.method === "GET" && path === "/auth/start") {
    const input = startQuery.parse(query(request));
    const login = await provider.start(input.provider);
    const response = redirect(login.url);
    const existing = readCookie(request, env, "session");
    const authenticated: Authentication = existing ? await provider.authenticate(existing) : { kind: "unauthenticated" };
    const previous = authenticated.kind === "authenticated" && authenticated.identity.provider === input.provider ? { userId: authenticated.identity.userId, name: authenticated.identity.name } : undefined;
    writeCookie(response, env, `login_${input.provider}`, await seal({ state: login.state, codeVerifier: login.codeVerifier, nonce: login.nonce, previous, returnTo: input.returnTo, provider: input.provider, expiresAt: Date.now() + 600000 }, env.SESSION_SECRET, `login_${input.provider}`), 600);
    return response;
  }
  const providerName = path === "/auth/callback/apple" ? "apple" : "google";
  if ((request.method === "GET" && path === "/auth/callback/google") || (request.method === "POST" && path === "/auth/callback/apple")) {
    let response: Response;
    try {
      if (providerName === "apple" && request.headers.get("Origin") !== "https://appleid.apple.com") throw new DashboardError(403, "origin_rejected");
      const loginCookie = readCookie(request, env, `login_${providerName}`);
      if (!loginCookie) throw new DashboardError(400, "login_state_missing");
      const login = transaction.parse(await unseal(loginCookie, env.SESSION_SECRET, `login_${providerName}`));
      const values = providerName === "apple" ? await form(request) : query(request);
      const input = callbackQuery.parse(values);
      if (login.expiresAt <= Date.now() || login.state !== input.state || login.provider !== providerName) throw new DashboardError(400, "login_state_rejected");
      const identity = await provider.exchange({ ...input, provider: providerName, codeVerifier: login.codeVerifier, nonce: login.nonce });
      if (!identity.name && login.previous?.userId === identity.userId) identity.name = login.previous.name;
      if (!identity.name) identity.name = identity.email;
      await resolveTenant(env, identity, true);
      response = redirect(startQuery.shape.returnTo.parse(login.returnTo));
      await setSession(response, env, await sealSession(identity, env.SESSION_SECRET), identity);
    } catch (error) {
      const failed = failure(error);
      response = redirect(`/dashboard/sign-in?failed=${providerName}`);
      response.headers.set("X-Request-ID", failed.headers.get("X-Request-ID") ?? "");
    }
    writeCookie(response, env, `login_${providerName}`, "", 0);
    return response;
  }
  if (request.method === "GET" && path === "/auth/session") {
    return json(await sessionDTO(await current(request, env, provider), env));
  }
  if (request.method === "POST" && path === "/auth/sign-out") {
    exactOrigin(request, env.DASHBOARD_ORIGIN);
    emptyBody.parse(await body(request));
    const bound = await binding(request, env);
    await checkCsrf(request, bound, env);
    const response = json({ ok: true, clearLocalBookmarks: true });
    clearSession(response, env);
    return response;
  }
  throw new DashboardError(405, "method_not_allowed");
}
async function dashboard(request: Request, env: DashboardEnvironment, provider: IdentityProvider, path: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") throw new DashboardError(405, "method_not_allowed");
  if (request.method === "POST") exactOrigin(request, env.DASHBOARD_ORIGIN);
  const person = await current(request, env, provider);
  if (request.method === "POST") await checkCsrf(request, person, env);
  const client = await engine(env, person);
  if (request.method === "GET") {
    switch (path) {
      case "/dashboard-api/home":
        return json(await homePage(client, pageQuery.parse(query(request)).cursor));
      case "/dashboard-api/call": {
        const input = callQuery.parse(query(request));
        return json(await callPage(client, input.spaceId, input.cursor));
      }
      case "/dashboard-api/past-session": {
        const input = pastQuery.parse(query(request));
        return json(await pastSessionPage(client, input.spaceId, input.episodeId, input.cursor, await viewerSeat(request, env, person, input.spaceId, input.episodeId)));
      }
      case "/dashboard-api/developer":
        return json(await developerPage(client, developerQuery.parse(query(request))));
      default:
        throw new DashboardError(404, "route_not_found");
    }
  }
  const input = await body(request);
  switch (path) {
    case "/dashboard-api/home": {
      const action = homeAction.parse(input);
      return json(await homeMutation(client, action));
    }
    case "/dashboard-api/call": {
      const action = callAction.parse(input);
      if (action.action === "join" || action.action === "refresh-access") return ownerAccess(request, env, client, person, action);
      return json(await callMutation(client, action));
    }
    case "/dashboard-api/past-session": {
      const action = pastAction.parse(input);
      return json(await pastMutation(client, action));
    }
    case "/dashboard-api/developer": {
      const action = developerAction.parse(input);
      return json(await developerMutation(client, action));
    }
    default:
      throw new DashboardError(404, "route_not_found");
  }
}
function failure(error: unknown): Response {
  const status = error instanceof DashboardError ? error.status : error instanceof z.ZodError ? 400 : 503;
  const code = error instanceof DashboardError ? error.code : error instanceof z.ZodError ? "invalid_request" : "service_unavailable";
  const requestId = crypto.randomUUID();
  console.warn(JSON.stringify({ event: "dashboard.request_failed", request_id: requestId, status, code, error_type: error instanceof Error ? error.name : typeof error, source: error instanceof Error ? error.stack?.split("\n")[1]?.trim().slice(0, 180) : undefined }));
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
