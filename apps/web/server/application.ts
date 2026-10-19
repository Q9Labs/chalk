import { z } from "zod";
import type { DashboardBindings, DashboardEnvironment } from "./config";
import { configuration } from "./config";
import type { Identity, IdentityProvider } from "./identity";
import { binding, checkCsrf, clearSession, csrfToken, readCookie, seal, setSession, unseal, writeCookie } from "./cookies";
import { body, DashboardError, exactOrigin, json, redirect } from "./http";
import { engine, resolveTenant } from "./engine";
import { homeMutation, homePage } from "./home";
import { ownerAccess, viewerSeat } from "./owner-access";
import { callMutation, callPage } from "./call";
import { pastMutation, pastSessionPage } from "./past-session";
import { developerMutation, developerPage, requiresOnline } from "./developer";
import { callAction, callQuery, developerAction, developerQuery, homeAction, pageQuery, pastAction, pastQuery } from "../src/lib/dashboard/contracts";
import type { RefreshRequiredDTO, SessionDTO } from "../src/lib/dashboard/contracts";

const startQuery = z.strictObject({
  provider: z.enum(["google", "apple"]),
  returnTo: z
    .string()
    .regex(/^\/dashboard(?:\/[a-zA-Z0-9/_-]*)?$/)
    .default("/dashboard"),
});
const callbackQuery = z.strictObject({ code: z.string().min(1).max(4096), state: z.string().min(1).max(1024) });
const transaction = z.object({ state: z.string(), codeVerifier: z.string(), returnTo: z.string(), provider: z.enum(["google", "apple"]), expiresAt: z.number() });
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
  if (result.kind !== "authenticated") throw new DashboardError(401, "refresh_or_sign_in_required");
  const bound = await binding(request, env);
  if (bound.userId !== result.identity.userId || bound.sessionId !== result.identity.sessionId) throw new DashboardError(401, "session_binding_mismatch");
  return result.identity;
}
async function online(provider: IdentityProvider, person: Identity): Promise<void> {
  if (!(await provider.online(person))) throw new DashboardError(401, "fresh_sign_in_required");
}
async function sessionDTO(person: Identity, env: DashboardEnvironment): Promise<SessionDTO> {
  return { profile: { name: person.name, email: person.email, avatarUrl: person.avatarUrl }, csrfToken: await csrfToken(person, env) };
}
async function auth(request: Request, env: DashboardEnvironment, provider: IdentityProvider, path: string): Promise<Response> {
  if (request.method === "GET" && path === "/auth/start") {
    const input = startQuery.parse(query(request));
    const login = await provider.start(input.provider);
    const response = redirect(login.url);
    writeCookie(response, env, "login", await seal({ state: login.state, codeVerifier: login.codeVerifier, returnTo: input.returnTo, provider: input.provider, expiresAt: Date.now() + 600000 }, env.WORKOS_COOKIE_PASSWORD, "login"), 600);
    return response;
  }
  if (request.method === "GET" && path === "/auth/callback") {
    let response: Response;
    let providerName: "google" | "apple" = "google";
    try {
      const loginCookie = readCookie(request, env, "login");
      if (!loginCookie) throw new DashboardError(400, "login_state_missing");
      const login = transaction.parse(await unseal(loginCookie, env.WORKOS_COOKIE_PASSWORD, "login"));
      providerName = login.provider;
      const input = callbackQuery.parse(query(request));
      if (login.expiresAt <= Date.now() || login.state !== input.state) throw new DashboardError(400, "login_state_rejected");
      const result = await provider.exchange(input.code, login.codeVerifier);
      await resolveTenant(env, result.identity, true);
      response = redirect(startQuery.shape.returnTo.parse(login.returnTo));
      await setSession(response, env, result.sealedSession, result.identity);
    } catch (error) {
      const failed = failure(error);
      response = redirect(`/dashboard/sign-in?failed=${providerName}`);
      response.headers.set("X-Request-ID", failed.headers.get("X-Request-ID") ?? "");
    }
    writeCookie(response, env, "login", "", 0);
    return response;
  }
  if (request.method === "GET" && path === "/auth/session") {
    try {
      return json(await sessionDTO(await current(request, env, provider), env));
    } catch (error) {
      if (!(error instanceof DashboardError) || error.code !== "refresh_or_sign_in_required") throw error;
      const bound = await binding(request, env);
      return json({ error: { code: "refresh_or_sign_in_required" }, csrfToken: await csrfToken(bound, env) } satisfies RefreshRequiredDTO, 401);
    }
  }
  if (request.method === "POST" && (path === "/auth/refresh" || path === "/auth/sign-out")) {
    exactOrigin(request, env.DASHBOARD_ORIGIN);
    emptyBody.parse(await body(request));
    const bound = await binding(request, env);
    await checkCsrf(request, bound, env);
    const sealed = readCookie(request, env, "session");
    if (!sealed) throw new DashboardError(401, "sign_in_required");
    if (path === "/auth/sign-out") {
      await provider.revoke({ ...bound, name: "", email: "", avatarUrl: null });
      const response = json({ ok: true, clearLocalBookmarks: true });
      clearSession(response, env);
      return response;
    }
    const refreshed = await provider.refresh(sealed);
    if (refreshed.kind === "transient") return json({ error: { code: "identity_temporarily_unavailable" } }, 503);
    if (refreshed.kind === "terminal" || refreshed.identity.userId !== bound.userId || refreshed.identity.sessionId !== bound.sessionId) {
      const response = failure(new DashboardError(401, refreshed.kind === "terminal" ? "sign_in_required" : "session_binding_mismatch"));
      clearSession(response, env);
      return response;
    }
    const response = json(await sessionDTO(refreshed.identity, env));
    await setSession(response, env, refreshed.sealedSession, refreshed.identity);
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
      if (requiresOnline(action)) await online(provider, person);
      return json(await homeMutation(client, action));
    }
    case "/dashboard-api/call": {
      const action = callAction.parse(input);
      if (requiresOnline(action)) await online(provider, person);
      if (action.action === "join" || action.action === "refresh-access") return ownerAccess(request, env, client, person, action);
      return json(await callMutation(client, action));
    }
    case "/dashboard-api/past-session": {
      const action = pastAction.parse(input);
      if (requiresOnline(action)) await online(provider, person);
      return json(await pastMutation(client, action));
    }
    case "/dashboard-api/developer": {
      const action = developerAction.parse(input);
      if (requiresOnline(action)) await online(provider, person);
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
