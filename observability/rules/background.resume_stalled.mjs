// @ts-check
import { failureIn, finding, verified } from "./access.connection_lost.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */

export const symptom = "background.resume_stalled";
export const expected = "after a witnessed suspend and return, the seat gets fresh Sync contact and a connected media peer";

/** @param {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} declaration @param {import("../../scripts/diagnose-call/proof/profile.mjs").Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} */
export function decide({ readings }) {
  const resume = readings["background.resume_check"];
  const failure = failureIn(resume);
  if (failure) {
    const observed = failure.claim === "dead_live" ? "after return, a hard-dead transport still advertised live" : "transport recovery exhausted after return";
    return finding(failure, "degraded", "resume", observed, "fresh contact and a connected peer on the same resume before recovery exhausted");
  }
  return verified(resume) ? { status: "pass" } : { status: "unknown", reason: "no covered checkpoint proved both transports after suspend and return" };
}
