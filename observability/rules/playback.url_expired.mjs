// @ts-check
/**
 * playback.url_expired: a dashboard playback failed on a URL older than its signed lifetime.
 * The API's mint and the player's media_error row with the URL's age prove it.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

import { PASS, asof, broken, fact, field, obs, renderJob, unknown } from "./recording.shared.mjs";

export const symptom = "playback.url_expired";
export const expected = "a playback URL is always used inside its signed lifetime, or refreshed before it lapses";
export const settle_ms = 60_000;


export const applies = renderJob;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const mints = obs(readings["playback.url"]);
  const errors = obs(readings["playback.error"]);
  if (!mints.length) return unknown("the API's URL mints are not witnessed");
  for (const err of errors) {
    const age = field(err, "url_age_ms", null);
    const lifetime = field(err, "url_lifetime_ms", null);
    if (age === null || lifetime === null) continue;
    if (age >= lifetime) {
      const mint = mints.find((m) => Math.abs(field(m, "playback_expires_ms", 0) - (field(m, "playback_signed_ms", 0) + lifetime)) < 60_000) ?? mints[0];
      return broken({
        hop: "player",
        module: "web.dashboard_player",
        observed: `media_error code=${err.claim} on a URL ${age}ms old against a ${lifetime}ms lifetime`,
        facts: [
          fact(`media_error code=${err.claim} url_age_ms=${age} url_lifetime_ms=${lifetime}`, [err]),
          fact(`mint signed=${field(mint, "playback_signed_ms", 0)} expires=${field(mint, "playback_expires_ms", 0)}`, [mint]),
        ],
        at: err.window.from_ms,
        evidence: [err, mint],
      });
    }
  }
  return PASS;
}
