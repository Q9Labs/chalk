// @ts-check
/**
 * live.no_reply: a live request was delivered, but no ack arrived in 10 s and no upload was issued in 30 s.
 *
 * The witnesses are in areas/report.json: the `live.request` row (delivered copies), Sync's `live_request.deliver` decision and
 * `live_request.ack` fact (independent: the decision is Sync's, the fact records the client's frame), the api/db upload issue
 * witnesses, and the client's `live_request.received`. A stalled tab can't report, so its silence alone proves nothing: the
 * finding needs the delivery proven and the ack and upload windows proven empty. Slice 9's perf_heartbeat, which attributes
 * module=web.page on a stall, and slice 7's freeze records for live.tab_frozen are not in this registry yet.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "live.no_reply";

/** The client has this long after delivery to ack. */
const ACK_MS = 10_000;
/** The client has this long after delivery to ask for its upload. */
const ISSUE_MS = 30_000;

export const settle_ms = 60_000;

export const healthy_absent = ["live.request", "live.deliver", "live.ack", "live.received", "report.upload_issued", "report.upload_row"];

export const expected = "a delivered live request is acked within 10 s and gets its upload issued within 30 s";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const request = readings["live.request"];
  if (request.kind === "unknown") return { status: "unknown", reason: "the live request rows are not read" };
  if (request.kind === "absent") return { status: "pass" };
  for (const name of ["live.deliver", "live.ack", "report.upload_issued", "report.upload_row"]) {
    if (readings[name].kind === "unknown") return { status: "unknown", reason: name.startsWith("live.") ? "sync is not complete" : "the upload rows are not complete" };
  }

  const delivers = readings["live.deliver"].kind === "present" ? readings["live.deliver"].observations : [];
  const acks = readings["live.ack"].kind === "present" ? readings["live.ack"].observations : [];
  const received = readings["live.received"].kind === "present" ? readings["live.received"].observations : [];
  const issueRows = readings["report.upload_row"].kind === "present" ? readings["report.upload_row"].observations : [];

  for (const req of [...request.observations].sort((a, b) => a.window.from_ms - b.window.from_ms)) {
    const id = req.value.live_request_id;
    const decision = delivers.find((o) => o.value.live_request_id === id);
    const delivery = String(decision !== undefined ? (decision.value.delivery ?? decision.claim) : req.value.delivery);
    if (!delivery.startsWith("delivered")) continue;
    const deliveredAt = typeof req.value.delivered_ms === "number" ? req.value.delivered_ms : (decision?.window.from_ms ?? req.window.from_ms);

    const acked = acks.some((o) => o.value.live_request_id === id && o.window.from_ms <= deliveredAt + ACK_MS);
    const issued = issueRows.some((o) => o.value.live_request_id === id && o.value.upload_trigger === "live" && typeof o.value.issued_ms === "number" && o.value.issued_ms <= deliveredAt + ISSUE_MS);
    if (acked || issued) continue;

    // Absence must be proven inside the windows: complete readings whose ends pass the deadlines.
    const ackCovered = (readings["live.ack"].kind === "absent" || readings["live.ack"].complete === true) && window.to_ms >= deliveredAt + ACK_MS;
    const issueCovered = (readings["report.upload_row"].kind === "absent" || readings["report.upload_row"].complete === true) && window.to_ms >= deliveredAt + ISSUE_MS;
    if (!ackCovered) return { status: "unknown", reason: "sync is not complete to the ack window" };
    if (!issueCovered) return { status: "unknown", reason: "the upload rows are not complete to the issue window" };

    const got = received.find((o) => o.value.live_request_id === id);
    const ackWindow = { from_ms: deliveredAt, to_ms: deliveredAt + ACK_MS };
    const issueWindow = { from_ms: deliveredAt, to_ms: deliveredAt + ISSUE_MS };
    // Point windows count as touching at the boundary, the same overlap the
    // proof's citations check applies — a zero-width ack at delivery time
    // still covers the window.
    const touches = (/** @type {Observation} */ o, /** @type {{from_ms:number,to_ms:number}} */ w) =>
      o.window.from_ms === o.window.to_ms || w.from_ms === w.to_ms
        ? o.window.from_ms <= w.to_ms && w.from_ms <= o.window.to_ms
        : o.window.from_ms < w.to_ms && w.from_ms < o.window.to_ms;
    const otherAcks = acks.filter((o) => o.value.live_request_id !== id && touches(o, ackWindow));
    const otherUploads = issueRows.filter((o) => o.value.live_request_id !== id && touches(o, issueWindow));
    return {
      status: "finding",
      outcome: "degraded",
      window: issueWindow,
      hop: "client_handler",
      module: "sdk.diagnostics",
      reason: null,
      upstream: "witnessed",
      observed: "delivered, but no ack within 10 s and no upload issued within 30 s",
      facts: [
        { text: `live_request.deliver delivered ${decision?.value.sockets ?? "?"} socket(s)`, evidence: [(decision ?? req).id], window: (decision ?? req).window, absent: null },
        // Absence is claimable only while nothing of the fact touches the window;
        // a row that names another request is itself the proof this one's never came.
        otherAcks.length === 0
          ? { text: "no live_request.ack within 10 s", evidence: [], window: ackWindow, absent: "live.ack" }
          : { text: "the acks inside the window all name other requests", evidence: otherAcks.map((o) => o.id), window: ackWindow, absent: null },
        otherUploads.length === 0
          ? { text: "no upload issued within 30 s", evidence: [], window: issueWindow, absent: "report.upload_row" }
          : { text: "the upload rows inside the window all name other requests", evidence: otherUploads.map((o) => o.id), window: issueWindow, absent: null },
        ...(got !== undefined ? [{ text: "the client's handler ran for the frame", evidence: [got.id], window: got.window, absent: null }] : []),
      ],
      hypothesis: got === undefined
        ? { text: "the tab stalled before it could run the handler", falsified_by: "a live_request.received or ack for the request" }
        : { text: "the handler ran but the ack and upload never went out", falsified_by: "a live_request.ack or upload row for the request" },
      falsify: { absence: null, attribution: "an ack within 10 s or an upload within 30 s of delivery" },
    };
  }
  return { status: "pass" };
}
