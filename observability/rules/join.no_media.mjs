// @ts-check
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "join.no_media";
export const expected = "an admitted Join confirms Sync entry and receives initial RTP, and also sends RTP when publishing";

const FAILURES = new Map([
  ["sync_timeout", ["sync_entry", "sdk.connection", "join.sync_timeout", "Sync did not reach live before the startup deadline"]],
  ["sync_failed", ["sync_entry", "sdk.connection", "join.sync_failed", "the SDK could not start or confirm Sync entry"]],
  ["publish_failed", ["publish", "sdk.media", "media.publish_failed", "the initial publish failed before RTP flowed"]],
  ["startup_ice_failed", ["ice", "sdk.media", "media.ice_failed", "the peer's ICE state failed before RTP flowed"]],
  ["startup_dtls_failed", ["dtls", "sdk.media", "media.dtls_failed", "the peer's DTLS state failed before RTP flowed"]],
  ["transport_timeout", ["transport", "sdk.media", "media.transport_timeout", "the peer transport timed out before RTP flowed"]],
  ["subscribe_timeout", ["subscribe", "sdk.media", "media.subscribe_timeout", "the pull did not deliver a remote track during the observed startup budget"]],
  ["rtp_timeout", ["rtp", "sdk.media", "media.rtp_timeout", "the connected peer measured zero RTP during the observed startup budget"]],
]);

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && declaration.features.includes("media") && seat !== null;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const initial = readings["join.initial"];
  if (initial.kind !== "present") return { status: "unknown", reason: "no timed initial Join was witnessed" };

  const failures = initial.observations
    .flatMap((row) => {
      const failure = FAILURES.get(row.claim);
      return failure ? [{ row, failure }] : [];
    })
    .sort((a, b) => a.row.window.from_ms - b.row.window.from_ms || a.row.id.localeCompare(b.row.id));
  const first = failures[0];
  if (first) {
    const [hop, module, , observed] = first.failure;
    return {
      status: "finding",
      outcome: "broken",
      window: first.row.window,
      hop,
      module,
      reason: null,
      upstream: "unknown",
      observed,
      facts: failures.map(({ row, failure: [, , code, message] }) => ({ text: `${code}: ${message}`, window: row.window, evidence: [row.id], absent: null })),
      hypothesis: null,
      falsify: { absence: null, attribution: "Read the same Join's Sync or SFU signaling history and packet counters before the reported failure." },
    };
  }

  const attempts = new Set(initial.observations.map(({ value }) => value.op_id));
  const completed = new Set(initial.observations.filter(({ claim }) => claim === "ready" || claim === "listen_only").map(({ value }) => value.op_id));
  if (attempts.size === 0 || [...attempts].some((id) => typeof id !== "string" || !completed.has(id))) return { status: "unknown", reason: "initial media was not proved in the required directions" };
  return { status: "pass" };
}
