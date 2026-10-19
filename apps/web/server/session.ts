import { z } from "zod";
import type { Authentication, Identity } from "./identity";
import { seal, unseal } from "./cookies";

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
const identitySchema = z.object({
  provider: z.enum(["google", "apple"]),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  name: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  expiresAt: z.number(),
});
export function sealSession(identity: Identity, secret: string): Promise<string> {
  return seal(identity, secret, "session");
}
export async function authenticate(sealed: string, secret: string): Promise<Authentication> {
  try {
    const identity = identitySchema.parse(await unseal(sealed, secret, "session"));
    if (identity.expiresAt <= Date.now()) return { kind: "unauthenticated" };
    return { kind: "authenticated", identity };
  } catch {
    return { kind: "unauthenticated" };
  }
}
