// @ts-check
/** Shared helpers for the slice 9 crash and performance rules: dead markers, seat hashing and reading guards. */
import { createHash } from "node:crypto";

/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Reading} Reading */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */

/** participant_id_hash is the SHA-256 hex of the participant's dashed UUID, matching apps/sync's ids.ex. */
export const hashParticipant = (participant) => createHash("sha256").update(participant).digest("hex");

/** Whether a required reading holds rows: absent and unknown both leave the rule's own call to make. */
export const present = (reading) => reading.kind === "present";

/** The dead runs a reporting seat found: previous_run markers with no clean_exit. */
export const deadMarkers = (reading) => (present(reading) ? reading.observations.filter((o) => o.value.clean_exit === undefined) : []);

/** Sync closes keyed by seat: a row names its seat by participant_id_hash. */
export function closesBySeatHash(reading) {
  /** @type {Map<string, Observation[]>} */
  const byHash = new Map();
  if (!present(reading)) return byHash;
  for (const o of reading.observations) {
    const hash = String(o.value.participant_id_hash ?? "");
    byHash.set(hash, [...(byHash.get(hash) ?? []), o]);
  }
  return byHash;
}

/** The seat a hashed server row names, or undefined when no declaration seat hashes to it. */
export function seatForHash(seats, hash) {
  return seats.find((seat) => hashParticipant(seat.participant) === hash);
}

/** The OS exit reasons that mean a crash, an ANR or a metric-confirmed death. */
export const CRASH_EXITS = new Set(["REASON_CRASH", "REASON_CRASH_NATIVE", "REASON_ANR", "MX_CRASH"]);
/** The OS exit reasons that mean the person ended the app. */
export const USER_EXITS = new Set(["REASON_USER_REQUESTED", "REASON_USER_STOPPED"]);
/** Exit reasons that are not an answer at all. */
export const NO_ANSWER_EXITS = new Set(["no_record", "no_exit_reason", "unsupported"]);
/** OS kills that are the system reclaiming the process, treated as killed, not crashed. */
export const OS_KILLS = new Set(["REASON_LOW_MEMORY", "REASON_EXCESSIVE_RESOURCE_USAGE", "REASON_FREEZER", "REASON_SIGNALED"]);
