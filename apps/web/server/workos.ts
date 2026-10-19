import { WorkOS } from "@workos-inc/node/worker";
import { z } from "zod";
import type { DashboardEnvironment } from "./config";
import type { Identity, IdentityProvider } from "./identity";
import { DashboardError } from "./http";

const tokenLifetime = z.object({ iat: z.number(), exp: z.number() });
function enforceLifetime(token: string): void {
  const payload = token.split(".")[1];
  if (!payload) throw new DashboardError(401, "invalid_identity_token");
  const claims = tokenLifetime.parse(JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))));
  if (claims.exp - claims.iat > 300 || claims.exp * 1000 <= Date.now()) throw new DashboardError(401, "identity_token_lifetime_rejected");
}
function identity(result: { sessionId: string; user: { id: string; firstName: string | null; lastName: string | null; email: string; profilePictureUrl: string | null } }): Identity {
  return { userId: result.user.id, sessionId: result.sessionId, name: [result.user.firstName, result.user.lastName].filter(Boolean).join(" "), email: result.user.email, avatarUrl: result.user.profilePictureUrl };
}
let cached: { apiKey: string; clientId: string; workos: WorkOS } | undefined;
export function workosProvider(env: DashboardEnvironment): IdentityProvider {
  if (!cached || cached.apiKey !== env.WORKOS_API_KEY || cached.clientId !== env.WORKOS_CLIENT_ID) {
    cached = { apiKey: env.WORKOS_API_KEY, clientId: env.WORKOS_CLIENT_ID, workos: new WorkOS(env.WORKOS_API_KEY, { clientId: env.WORKOS_CLIENT_ID }) };
  }
  const workos = cached.workos;
  const load = (sessionData: string) => workos.userManagement.loadSealedSession({ sessionData, cookiePassword: env.WORKOS_COOKIE_PASSWORD });
  return {
    start: (provider) => workos.userManagement.getAuthorizationUrlWithPKCE({ provider: provider === "google" ? "GoogleOAuth" : "AppleOAuth", redirectUri: env.WORKOS_REDIRECT_URI, clientId: env.WORKOS_CLIENT_ID }),
    async exchange(code, codeVerifier) {
      const result = await workos.userManagement.authenticateWithCode({ code, codeVerifier, clientId: env.WORKOS_CLIENT_ID, session: { sealSession: true, cookiePassword: env.WORKOS_COOKIE_PASSWORD } });
      if (!result.sealedSession) throw new DashboardError(502, "identity_session_missing");
      const checked = await load(result.sealedSession).authenticate();
      if (!checked.authenticated) throw new DashboardError(401, "sign_in_required");
      enforceLifetime(checked.accessToken);
      return { sealedSession: result.sealedSession, identity: identity(checked) };
    },
    async authenticate(sealed) {
      const result = await load(sealed).authenticate();
      if (!result.authenticated) return { kind: "unauthenticated" };
      enforceLifetime(result.accessToken);
      return { kind: "authenticated", identity: identity(result) };
    },
    async refresh(sealed) {
      const result = await load(sealed).refresh();
      if (!result.authenticated) return { kind: result.retryable ? "transient" : "terminal" };
      if (!result.sealedSession) return { kind: "terminal" };
      const checked = await load(result.sealedSession).authenticate();
      if (!checked.authenticated) return { kind: "terminal" };
      enforceLifetime(checked.accessToken);
      return { kind: "refreshed", sealedSession: result.sealedSession, identity: identity(checked) };
    },
    async online(person) {
      const sessions = await workos.userManagement.listSessions(person.userId);
      for (const session of await sessions.autoPagination()) {
        if (session.id === person.sessionId) return session.status === "active" && Date.parse(session.expiresAt) > Date.now();
      }
      return false;
    },
    async revoke(person) {
      await workos.userManagement.revokeSession({ sessionId: person.sessionId });
    },
  };
}
