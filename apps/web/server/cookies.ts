import { z } from "zod";
import type { DashboardEnvironment } from "./config";
import type { Identity } from "./identity";
import { DashboardError } from "./http";

type CookiePurpose = "session" | "login" | "binding" | `seat_${string}`;
const encoder = new TextEncoder();
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}
async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(secret)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(value: unknown, secret: string, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(purpose) }, await key(secret), encoder.encode(JSON.stringify(value)));
  return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function unseal(value: string, secret: string, purpose: string): Promise<unknown> {
  const [iv, ciphertext, extra] = value.split(".");
  if (!iv || !ciphertext || extra) throw new DashboardError(401, "invalid_cookie");
  try {
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: encoder.encode(purpose) }, await key(secret), bytes(ciphertext))));
  } catch {
    throw new DashboardError(401, "invalid_cookie");
  }
}
function cookieName(env: DashboardEnvironment, purpose: CookiePurpose): string {
  return `${new URL(env.DASHBOARD_ORIGIN).protocol === "https:" ? "__Host-" : "local_"}chalk_${purpose}`;
}
export function readCookie(request: Request, env: DashboardEnvironment, purpose: CookiePurpose): string | undefined {
  const prefix = `${cookieName(env, purpose)}=`;
  return request.headers
    .get("Cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(prefix))
    ?.slice(prefix.length);
}
export function writeCookie(response: Response, env: DashboardEnvironment, purpose: CookiePurpose, value: string, maxAge = 604800): void {
  const secure = new URL(env.DASHBOARD_ORIGIN).protocol === "https:" ? "; Secure" : "";
  response.headers.append("Set-Cookie", `${cookieName(env, purpose)}=${value}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`);
}
const bindingSchema = z.object({ userId: z.string(), sessionId: z.string(), expiresAt: z.number() });
export type SessionBinding = z.infer<typeof bindingSchema>;
export async function binding(request: Request, env: DashboardEnvironment): Promise<SessionBinding> {
  const value = readCookie(request, env, "binding");
  if (!value) throw new DashboardError(401, "sign_in_required");
  const result = bindingSchema.parse(await unseal(value, env.WORKOS_COOKIE_PASSWORD, "binding"));
  if (result.expiresAt < Date.now()) throw new DashboardError(401, "sign_in_required");
  return result;
}
export async function csrfToken(identity: Pick<Identity, "userId" | "sessionId">, env: DashboardEnvironment): Promise<string> {
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(env.WORKOS_COOKIE_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode(JSON.stringify(["dashboard-csrf-v1", identity.userId, identity.sessionId])))));
}
export async function checkCsrf(request: Request, identity: Pick<Identity, "userId" | "sessionId">, env: DashboardEnvironment): Promise<void> {
  const supplied = request.headers.get("X-CSRF-Token") ?? "";
  const expected = await csrfToken(identity, env);
  let difference = supplied.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ (supplied.charCodeAt(i) || 0);
  if (difference !== 0) throw new DashboardError(403, "csrf_rejected");
}
export async function setSession(response: Response, env: DashboardEnvironment, sealedSession: string, identity: Identity): Promise<void> {
  writeCookie(response, env, "session", sealedSession);
  writeCookie(response, env, "binding", await seal({ userId: identity.userId, sessionId: identity.sessionId, expiresAt: Date.now() + 604800000 }, env.WORKOS_COOKIE_PASSWORD, "binding"));
}
export function clearSession(response: Response, env: DashboardEnvironment): void {
  writeCookie(response, env, "session", "", 0);
  writeCookie(response, env, "binding", "", 0);
}
