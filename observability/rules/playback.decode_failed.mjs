// @ts-check
/**
 * playback.decode_failed: a dashboard playback failed inside the URL's lifetime — a decode error where the
 * browser can play MP4, or a network/abort error before expiry. The R2 readback decides whether the object
 * or the player is at fault: an undecodable object is recording.artifact_unreadable's finding, not this one's.
 * A src_not_supported error on a browser that says it cannot play MP4 is expected(playback.unsupported_browser).
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

import { PASS, broken, expectedFinding, fact, field, obs, renderJob, unknown } from "./recording.shared.mjs";

export const symptom = "playback.decode_failed";
export const expected = "a viewer who can play MP4 always plays a committed Recording inside the URL's lifetime";
export const settle_ms = 60_000;
export const healthy_absent = ["playback.error"];


export const applies = renderJob;

/** MediaError codes: 3 decode, 4 src_not_supported. */
const DECODE = 3;
const SRC_NOT_SUPPORTED = 4;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const errors = obs(readings["playback.error"]);
  if (readings["playback.error"]?.kind === "unknown") return unknown("the player's reports are not read");
  if (!errors.length) return PASS;
  if (readings["recording.object"]?.kind === "unknown") return unknown("the stored object was not read back");
  const object = obs(readings["recording.object"])[0];
  for (const err of errors) {
    const age = field(err, "url_age_ms", null);
    const lifetime = field(err, "url_lifetime_ms", null);
    if (age !== null && lifetime !== null && age >= lifetime) continue; // playback.url_expired's call
    const code = field(err, "media_error_code", err.claim);
    const canPlay = field(err, "can_play_mp4", "probably");
    const at = err.window.from_ms;
    if (code === SRC_NOT_SUPPORTED && canPlay === "") {
      return expectedFinding({
        hop: "player",
        module: "web.dashboard_player",
        reason: "playback.unsupported_browser",
        observed: `media_error src_not_supported and canPlayType(mp4) answered "": the browser cannot play MP4`,
        facts: [fact(`media_error code=4 can_play_mp4=""`, [err])],
        at,
        evidence: [err],
      });
    }
    if (object && object.claim !== "ok") continue; // artifact_unreadable owns an unreadable object
    if (code === DECODE || code === SRC_NOT_SUPPORTED || typeof code === "number") {
      return broken({
        hop: "player",
        module: "web.dashboard_player",
        observed: `media_error code=${code} url_age_ms=${age ?? "?"} inside the signed lifetime${object ? " on a readable object" : ""}`,
        facts: [fact(`media_error code=${code} can_play_mp4=${canPlay} url_age_ms=${age ?? "?"}`, [err]), ...(object ? [fact(`readback ok duration=${field(object, "recording_probe_duration_ms", "?")}ms`, [object])] : [])],
        at,
        evidence: [err, ...(object ? [object] : [])],
      });
    }
  }
  return PASS;
}
