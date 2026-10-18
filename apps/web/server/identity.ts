export type Identity = { userId: string; sessionId: string; name: string; email: string; avatarUrl: string | null };
export type Login = { url: string; state: string; codeVerifier: string };
export type Authentication = { kind: "authenticated"; identity: Identity } | { kind: "unauthenticated" };
export type Refresh = { kind: "refreshed"; identity: Identity; sealedSession: string } | { kind: "transient" } | { kind: "terminal" };
export interface IdentityProvider {
  start(provider: "google" | "apple"): Promise<Login>;
  exchange(code: string, codeVerifier: string): Promise<{ sealedSession: string; identity: Identity }>;
  authenticate(sealedSession: string): Promise<Authentication>;
  refresh(sealedSession: string): Promise<Refresh>;
  online(identity: Identity): Promise<boolean>;
  revoke(identity: Identity): Promise<void>;
}
