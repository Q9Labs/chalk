// @ts-check
/**
 * live.target_unreachable: a live request for an active seat in an active Episode reached no socket.
 *
 * The witnesses are in areas/report.json: the `live.request` row (population, requested_at, the status snapshot, the delivery
 * copy), Sync's `live_request.deliver` decision (one witness with the column it writes) and the seat's `live.client_presence`
 * sessions for the old-client expected. Slice 7's socket close records, which attribute the module, are not in this registry yet:
 * a no_socket finding names module=unknown until they land.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "live.target_unreachable";

/** A request row still undelivered at expires_at proves the notification never ran. */
const EXPIRES_MS = 60_000;
/** A client session this recent counts for the old-client expected. */
const PRESENCE_MS = 60_000;
/** The first SDK that negotiates live introspection. */
const LIVE_MIN_SDK_VERSION = "4.0.0";

export const settle_ms = EXPIRES_MS;

export const healthy_absent = ["live.request", "live.deliver", "live.client_presence"];

export const expected = "a live request for an active seat in an active Episode is delivered to at least one socket, unless every one of the seat's clients is too old to take it";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {string} a @param {string} b */
const semverLt = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
};

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const request = readings["live.request"];
  if (request.kind === "unknown") return { status: "unknown", reason: "the live request rows are not read" };
  if (request.kind === "absent") return { status: "pass" };
  const deliver = readings["live.deliver"];
  if (deliver.kind === "unknown") return { status: "unknown", reason: "the sync delivery decisions are not complete" };
  const decisions = deliver.kind === "present" ? deliver.observations : [];

  for (const req of [...request.observations].sort((a, b) => a.window.from_ms - b.window.from_ms)) {
    const id = req.value.live_request_id;
    const decision = decisions.find((o) => o.value.live_request_id === id);
    const active = req.value.participant_status === "active" && req.value.seat_left_ms === undefined && req.value.episode_status === "active";
    if (!active) continue;
    const delivery = decision !== undefined ? decision.claim : req.value.delivery;
    const reason = decision !== undefined ? decision.value.unavailable_reason : req.value.unavailable_reason;
    const requested = typeof req.value.requested_ms === "number" ? req.value.requested_ms : req.window.from_ms;
    const expires = typeof req.value.expires_ms === "number" ? req.value.expires_ms : requested + EXPIRES_MS;

    if (delivery === "target_unavailable" && reason === "no_socket") {
      return degraded(req, decision, "sync_socket", "unknown", `live_request.deliver target_unavailable(no_socket)`);
    }
    if (delivery === "target_unavailable" && reason === "not_negotiated") {
      const presence = readings["live.client_presence"];
      if (presence.kind !== "present") return { status: "unknown", reason: "the seat's client sessions are not read" };
      const sessions = presence.observations.filter((o) => o.window.to_ms >= requested - PRESENCE_MS && o.window.from_ms <= requested);
      if (sessions.length === 0 || sessions.some((o) => o.value.sdk_version === undefined)) return { status: "unknown", reason: "a client session of the seat lacks an SDK version" };
      if (sessions.every((o) => semverLt(String(o.value.sdk_version), LIVE_MIN_SDK_VERSION))) {
        return {
          status: "finding",
          outcome: "expected",
          window: req.window,
          hop: null,
          module: null,
          reason: "live.old_client",
          upstream: null,
          observed: "every client session of the seat is below the live-introspection minimum",
          facts: [
            { text: "seat active and Episode active at the request", evidence: [req.id], window: req.window, absent: null },
            { text: `live_request.deliver target_unavailable(not_negotiated)`, evidence: [(decision ?? req).id], window: (decision ?? req).window, absent: null },
          ],
          hypothesis: null,
          falsify: { absence: null, attribution: `a client session at or above ${LIVE_MIN_SDK_VERSION}` },
        };
      }
      return { status: "unknown", reason: "the seat has a client session that could take the request, yet none was negotiated" };
    }
    if (delivery === undefined || req.value.request_status === "pending") {
      if (window.to_ms < expires) return { status: "unknown", reason: "the request is still inside its expiry window" };
      if (deliver.kind !== "absent" && deliver.complete !== true) return { status: "unknown", reason: "sync is not complete to expires_at" };
      return degraded(req, decision, "sync_listener", "sync.live", "the request sat undelivered to its expires_at");
    }
  }
  return { status: "pass" };
}

/** @param {Observation} req @param {Observation|undefined} decision @param {string} hop @param {string} module @param {string} observed */
function degraded(req, decision, hop, module, observed) {
  return {
    status: "finding",
    outcome: "degraded",
    window: req.window,
    hop,
    module,
    reason: null,
    upstream: "unknown",
    observed,
    facts: [
      { text: "seat active and Episode active at the request", evidence: [req.id], window: req.window, absent: null },
      { text: observed, evidence: [(decision ?? req).id], window: (decision ?? req).window, absent: null },
    ],
    hypothesis: null,
    falsify: { absence: null, attribution: "a delivered delivery on the request row" },
  };
}
