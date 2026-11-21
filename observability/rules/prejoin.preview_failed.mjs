// @ts-check
/**
 * prejoin.preview_failed: a device failed to open for a reason other than refusal (NotAllowedError, SecurityError) or absence
 * (NotFoundError, OverconstrainedError). The DOMException name comes from prejoin.device_error, which classify drops.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "prejoin.preview_failed";

const DENIED_OR_MISSING = new Set(["NotAllowedError", "SecurityError", "NotFoundError", "OverconstrainedError"]);

export const expected = "a prejoin device only fails by refusal or absence";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "attempt";

export const healthy_absent = ["prejoin.device"];

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const devices = readings["prejoin.device"];
  if (devices.kind === "unknown") return { status: "unknown", reason: "client incomplete" };
  if (devices.kind !== "present") return { status: "pass" };
  const failed = devices.observations.find((o) => !DENIED_OR_MISSING.has(o.claim));
  if (!failed) return { status: "pass" };
  return {
    status: "finding",
    outcome: "broken",
    window: failed.window,
    hop: "client_capture",
    module: "react.prejoin",
    reason: null,
    upstream: "unknown",
    observed: `the ${failed.value.device ?? "device"} failed to open with ${failed.claim}, not a refusal or a missing device`,
    facts: [{ text: `prejoin.device_error device=${failed.value.device ?? "?"} error_name=${failed.claim}`, evidence: [failed.id], window: failed.window, absent: null }],
    hypothesis: null,
    falsify: { absence: "a prejoin.device_error row", attribution: "a refusal or absent-device error name" },
  };
}
