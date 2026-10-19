export type Provider = "google" | "apple";
export type Identity = { provider: Provider; userId: string; sessionId: string; name: string; email: string; avatarUrl: string | null; expiresAt: number };
export type Login = { url: string; state: string; codeVerifier: string; nonce: string };
export type Exchange = { provider: Provider; code: string; codeVerifier: string; nonce: string; user?: string };
export type Authentication = { kind: "authenticated"; identity: Identity } | { kind: "unauthenticated" };
export interface IdentityProvider {
  start(provider: Provider): Promise<Login>;
  exchange(input: Exchange): Promise<Identity>;
  authenticate(sealedSession: string): Promise<Authentication>;
}
