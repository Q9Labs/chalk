// @ts-check
/**
 * live.upload_missing: a live request was acked, but no bundle downloads and parses from R2 within 60 s of delivery.
 *
 * The witnesses are the same as report.upload_missing, keyed by the live request: the `live.request` row and its `live.ack`
 * (which start the window), the `report.upload.issue` and `report.upload.complete` decisions with the `diagnostic_uploads` row
 * (one witness), the client's `report.upload` op, and `report.readback`, the checker's own GET and parse. The live.page_hidden
 * expected waits for slice 9's pagehide records, which this registry does not have yet.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "live.upload_missing";

/** The client has this long after delivery to ask for the upload. */
const ISSUE_MS = 30_000;
/** The client has this long after delivery for the bundle to be stored and read back. */
const STORE_MS = 60_000;

export const settle_ms = 150_000;

export const healthy_absent = ["live.request", "live.ack", "report.upload_issued", "report.upload_completed", "report.upload_row", "report.upload", "report.readback"];

export const expected = "an acked live request gets its upload issued and stored, and the bundle downloads and parses from R2 within 60 s of delivery";

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
  const ack = readings["live.ack"];
  if (ack.kind === "unknown") return { status: "unknown", reason: "sync is not complete" };
  for (const name of ["report.upload_issued", "report.upload_completed", "report.upload_row"]) {
    if (readings[name].kind === "unknown") return { status: "unknown", reason: "the upload rows are not complete" };
  }
  const readbackRead = readings["report.readback"];
  if (readbackRead.kind === "unknown") return { status: "unknown", reason: "r2 is not read" };

  const acks = ack.kind === "present" ? ack.observations : [];
  const rows = readings["report.upload_row"].kind === "present" ? readings["report.upload_row"].observations : [];
  const readbacks = readbackRead.kind === "present" ? readbackRead.observations : [];
  const uploads = readings["report.upload"].kind === "present" ? readings["report.upload"].observations : [];

  for (const req of [...request.observations].sort((a, b) => a.window.from_ms - b.window.from_ms)) {
    const id = req.value.live_request_id;
    const acked = acks.filter((o) => o.value.live_request_id === id);
    if (acked.length === 0) continue;
    const deliveredAt = typeof req.value.delivered_ms === "number" ? req.value.delivered_ms : acked[0].window.from_ms;
    const row = rows.find((o) => o.value.live_request_id === id && o.value.upload_trigger === "live");
    const op = row === undefined ? undefined : uploads.find((o) => o.value.diagnostic_upload_id === row.value.diagnostic_upload_id);

    if (row === undefined) {
      if (window.to_ms < deliveredAt + ISSUE_MS) return { status: "unknown", reason: "the 30 s issue window has not run out" };
      return degraded(req, acked[0], { from_ms: deliveredAt, to_ms: deliveredAt + ISSUE_MS }, "client", "sdk.diagnostics", "never_requested", "the client never asked for the upload", []);
    }
    const issuedAt = typeof row.value.issued_ms === "number" ? row.value.issued_ms : row.window.from_ms;
    if (row.claim !== "stored") {
      if (row.claim === "issued" && window.to_ms < deliveredAt + STORE_MS) return { status: "unknown", reason: "the upload is still inside its 60 s store window" };
      const module = op !== undefined && op.claim === "error" && op.value.reason_code === "report.network" ? "network" : "sdk.diagnostics";
      return degraded(req, acked[0], { from_ms: deliveredAt, to_ms: deliveredAt + STORE_MS }, "client_upload", module, "not_uploaded", "upload issued, never stored", citeOp(op, row, readbacks));
    }
    const readback = readbacks.find((o) => o.value.diagnostic_upload_id === row.value.diagnostic_upload_id);
    if (readback === undefined) return { status: "unknown", reason: "the checker never read the stored object back" };
    if (readback.claim !== "ok") {
      return degraded(req, acked[0], row.window, "r2", "api.diagnosticuploads", "readback_failed", `the readback was ${readback.claim}`, [{ text: `R2 readback ${readback.claim}`, evidence: [readback.id], window: readback.window, absent: null }]);
    }
  }
  return { status: "pass" };
}

/** The "no R2 object" fact claims an absence only when provable: no readback observation may overlap the upload's window. @param {Observation|undefined} op @param {Observation} row @param {readonly Observation[]} readbacks */
const citeOp = (op, row, readbacks) => {
  const facts = [{ text: "upload issued, never stored", evidence: [row.id], window: row.window, absent: null }];
  if (op !== undefined) facts.push({ text: `report.upload error(${op.value.reason_code === "report.network" ? "network" : String(op.value.reason_code)})`, evidence: [op.id], window: op.window, absent: null });
  // Absence is claimable only while nothing of the fact touches the window:
  // the same inclusive overlap provenAbsent applies in run-check.
  const touches = (o) => (o.window.from_ms === o.window.to_ms || row.window.from_ms === row.window.to_ms ? o.window.from_ms <= row.window.to_ms && row.window.from_ms <= o.window.to_ms : o.window.from_ms < row.window.to_ms && row.window.from_ms < o.window.to_ms);
  if (!readbacks.some(touches)) facts.push({ text: "no R2 object for the upload", evidence: [], window: row.window, absent: "report.readback" });
  return facts;
};

/** @param {Observation} req @param {Observation} acked @param {import("../../scripts/diagnose-call/proof/evidence.mjs").Window} window @param {string} hop @param {string} module @param {string} cause @param {string} observed @param {import("../../scripts/diagnose-call/proof/profile.mjs").Fact[]} extraFacts */
function degraded(req, acked, window, hop, module, cause, observed, extraFacts) {
  return {
    status: "finding",
    outcome: "degraded",
    window,
    hop,
    module,
    reason: null,
    upstream: "unknown",
    observed: `${observed} (${cause})`,
    facts: [
      { text: "live_request.ack", evidence: [acked.id], window: acked.window, absent: null },
      ...extraFacts,
    ],
    hypothesis: null,
    falsify: { absence: null, attribution: "a stored bundle that downloads and parses" },
  };
}
