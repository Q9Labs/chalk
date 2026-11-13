import type { AccessGrant } from "../access/grant.js";
import type { PublicSpaceArrival } from "./types.js";

/** Where an arrival stands, from the server's answer. */
export type EntranceStep =
  | { readonly state: "admitted"; readonly access: AccessGrant }
  /** Let in, but the answer carried no access: arrive again with the same handle to get it. */
  | { readonly state: "admitted_without_access" }
  /** Waiting for the host. Ask again after `retryAfterMs`. */
  | { readonly state: "pending"; readonly retryAfterMs: number }
  | { readonly state: "declined"; readonly reason: string };

export function entranceStep(arrival: PublicSpaceArrival): EntranceStep {
  if (arrival.state === "pending") return { state: "pending", retryAfterMs: arrivalRetryDelayMs(arrival.retry_after) };
  if (arrival.state === "admitted") return arrival.access ? { state: "admitted", access: arrival.access } : { state: "admitted_without_access" };
  return { state: "declined", reason: arrival.state };
}

/** `retry_after` is in seconds. A missing or invalid value waits one second; anything else stays between 250 ms and 30 s. */
export function arrivalRetryDelayMs(retryAfter: number | undefined): number {
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) return 1000;
  return Math.min(Math.max(retryAfter * 1000, 250), 30000);
}

/** The API error code of a failed arrival call, if it has one. */
export function arrivalErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("error" in cause)) return undefined;
  const error: unknown = cause.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** The arrival is already gone for good, so asking again or leaving again changes nothing. */
export function isTerminalArrivalError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  if ("status" in cause && (cause.status === 404 || cause.status === 410)) return true;
  const code = arrivalErrorCode(cause);
  return code === "arrival.invalid_handle" || code === "arrival.unavailable" || code === "space_public_invite.unavailable";
}

/** Waits before each retry, about 5.5 s in all. */
const ENDING_EPISODE_RETRY_DELAYS_MS = [500, 1000, 1500, 2500];

/**
 * A Rejoin can land while the server is ending the old Episode, which answers `episode.not_active`.
 * Once that Episode has ended, the next arrival starts a fresh one, so retry for a few seconds first.
 */
export async function arriveRetryingEndingEpisode<T>(arrive: () => Promise<T>): Promise<T> {
  for (const delayMs of ENDING_EPISODE_RETRY_DELAYS_MS) {
    try {
      return await arrive();
    } catch (cause) {
      if (arrivalErrorCode(cause) !== "episode.not_active") throw cause;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return arrive();
}
