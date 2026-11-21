// @ts-check
/**
 * prejoin.devices_blocked: the browser refused devices without the visitor refusing a prompt. Framing and the page's device
 * policy come from boot.started; a host policy or OS refusal shows no prompt, so these client facts are the only witness.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "prejoin.devices_blocked";

export const expected = "prejoin reaches blocked only when the visitor refused the prompt or the browser kept an earlier refusal";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "attempt";

const UNREADABLE = "unavailable(no_api)";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const started = readings["boot.started"];
  const access = readings["prejoin.access"];
  if (started.kind === "unknown" || access.kind === "unknown") return { status: "unknown", reason: "client incomplete" };
  if (access.kind !== "present" || started.kind !== "present") return { status: "pass" };
  const blocked = access.observations.filter((o) => o.claim === "blocked");
  if (blocked.length === 0) return { status: "pass" };
  const boot = started.observations[0];
  const framed = boot.value.framed === true;
  const policies = [boot.value.policy_camera, boot.value.policy_microphone];
  if (framed && policies.includes(UNREADABLE)) return { status: "unknown", reason: "policy unreadable in the frame" };
  const policyDenies = policies.includes("false");
  const policyAllows = policies.every((p) => p === "true");
  const edge = blocked[0];

  if (framed && policyDenies) {
    return {
      status: "finding",
      outcome: "broken",
      window: edge.window,
      hop: "host_permissions_policy",
      module: "react.prejoin",
      reason: null,
      upstream: "witnessed",
      observed: "the host frame's permissions policy denies the devices; no prompt can run",
      facts: [
        { text: `boot.started framed=true policy_camera=${boot.value.policy_camera} policy_microphone=${boot.value.policy_microphone}`, evidence: [boot.id], window: boot.window, absent: null },
        { text: `prejoin.access ${edge.value.from_state}->blocked by ${edge.value.trigger}`, evidence: [edge.id], window: edge.window, absent: null },
      ],
      hypothesis: { text: "the embedding page's allow attribute or Permissions-Policy header lacks the devices", falsified_by: "a prompt the visitor could answer" },
      falsify: { absence: null, attribution: "a prompt refused on a page whose policy allows both devices" },
    };
  }

  const lastQuery = access.observations.filter((o) => o.value.trigger === "permission_query").at(-1);
  const osDenied = blocked.find((o) => o.value.trigger === "preview_open" && o.value.error_name === "NotAllowedError");
  if (osDenied && lastQuery && lastQuery.claim !== "blocked") {
    return {
      status: "finding",
      outcome: "broken",
      window: osDenied.window,
      hop: "os_permission",
      module: "react.prejoin",
      reason: null,
      upstream: "witnessed",
      observed: "preview_open failed NotAllowedError after a permission_query read granted; the OS or browser denied it without a prompt",
      facts: [
        { text: `prejoin.access ${lastQuery.value.from_state}->${lastQuery.claim} by permission_query`, evidence: [lastQuery.id], window: lastQuery.window, absent: null },
        { text: `prejoin.access ${osDenied.value.from_state}->blocked by preview_open error_name=NotAllowedError`, evidence: [osDenied.id], window: osDenied.window, absent: null },
      ],
      hypothesis: { text: "the OS-level camera or microphone permission is off for the browser", falsified_by: "a visitor-visible prompt refusing it" },
      falsify: { absence: null, attribution: "a prompt the visitor refused" },
    };
  }

  if (policyAllows && edge.value.from_state === "requesting") {
    return {
      status: "finding",
      outcome: "expected",
      window: edge.window,
      hop: null,
      module: null,
      reason: "prejoin.prompt_refused",
      upstream: "witnessed",
      observed: "the visitor refused the browser's device prompt on a page whose policy allows both devices",
      facts: [{ text: `prejoin.access requesting->blocked by ${edge.value.trigger}`, evidence: [edge.id], window: edge.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "a policy or OS refusal" },
    };
  }
  if (policyAllows && !framed && edge.value.trigger === "permission_query" && edge.value.from_state === "checking") {
    return {
      status: "finding",
      outcome: "expected",
      window: edge.window,
      hop: null,
      module: null,
      reason: "prejoin.refusal_remembered",
      upstream: "witnessed",
      observed: "the browser kept an earlier refusal on an unframed page whose policy allows both devices",
      facts: [{ text: "prejoin.access checking->blocked by permission_query", evidence: [edge.id], window: edge.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "a host-policy or OS refusal" },
    };
  }
  return { status: "pass" };
}
