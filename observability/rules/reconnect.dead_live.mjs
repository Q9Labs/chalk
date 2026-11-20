// @ts-check
import { failureIn, finding, verified } from "./access.connection_lost.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */

export const symptom = "reconnect.dead_live";
export const expected = "the current Sync socket has fresh contact and the current media transport has a connected peer after any interrupted checkpoint";

/** @param {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} declaration @param {import("../../scripts/diagnose-call/proof/profile.mjs").Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} */
export function decide({ readings }) {
  const sync = readings["reconnect.sync_check"];
  const media = readings["reconnect.media_check"];
  const deadSync = failureIn(sync);
  if (deadSync) return finding(deadSync, "broken", "transport_liveness", "Sync still advertised live after an unanswered ping crossed its hard deadline", "the same socket left live when the hard watchdog handled the deadline");
  const deadMedia = failureIn(media);
  if (deadMedia) return finding(deadMedia, "broken", "transport_liveness", "media still advertised live after a hard peer failure and no recovery was queued", "the current peer was connected or its recovery was queued at the checkpoint");
  if (verified(sync) && verified(media)) return { status: "pass" };
  return { status: "unknown", reason: "fresh Sync contact and a connected media peer are not both witnessed after the last interruption" };
}
