import { ArrivalUnavailableError, MediaUnavailableError, SpacePublicInviteUnavailableError } from "@q9labsai/chalk-client";

export type EntryFailure = { readonly message: string; readonly retryable: boolean; readonly retryLabel?: string; readonly reason?: "declined" | "expired" };

export const neutralSpaceError = "This Space is unavailable. Please check the invite link and try again.";

/** What the visitor reads when the host answered their request with something other than "come in". */
export function declinedFailure(state: string): EntryFailure {
  if (state === "rejected") return { message: "The host didn’t let you in", retryable: true, reason: "declined" };
  if (state === "unavailable") return { message: "Your request to join expired or is no longer available.", retryable: true, reason: "expired" };
  return { message: "Your request to join is no longer active.", retryable: true };
}

export function entryFailure(cause: unknown): EntryFailure {
  // Generated public-invite errors keep their contract code across Promise rejection.
  if (cause instanceof SpacePublicInviteUnavailableError) return { message: "This invite link is unavailable. Ask the host for a new link.", retryable: false };
  if (cause instanceof ArrivalUnavailableError) return { message: "Your request to join is no longer available. Open the invite link and join again.", retryable: false };
  if (cause instanceof MediaUnavailableError) return { message: "Calls are unavailable right now. Try again in a few minutes.", retryable: true };
  if (typeof cause === "object" && cause !== null && "status" in cause) {
    if (cause.status === 404 || cause.status === 410) return { message: neutralSpaceError, retryable: false };
    if (cause.status === 401) return { message: "Sign in again, then enter this Space.", retryable: true };
    if (cause.status === 403) return { message: "You do not have access to this Space. Ask the owner for access.", retryable: true };
    if (cause.status === 429) return { message: "Too many requests. Wait a minute, then enter this Space again.", retryable: true };
    if (cause.status === 409) return { message: "You could not enter this Space. Try entering again.", retryable: true };
  }
  if (globalThis.navigator?.onLine === false) return { message: "You’re offline. Reconnect, then try again.", retryable: true };
  if (cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number" && cause.status >= 500) return { message: "Chalk is having trouble right now. Try again in a minute.", retryable: true };
  return { message: "Couldn’t reach Chalk. Check your connection, then try again.", retryable: true };
}
