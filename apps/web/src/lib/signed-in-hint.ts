/**
 * A cookie that only says "a session was started in this browser". It carries no identity and
 * grants nothing, so the public site can read it before paint and show Dashboard instead of
 * Sign in. The dashboard still checks the real session.
 */
export const SIGNED_IN_COOKIE = "chalk_signed_in";

/** Drops the hint in this browser once the server says the session is gone. */
export function clearSignedInHint(): void {
  document.cookie = `${SIGNED_IN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
