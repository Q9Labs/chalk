// @ts-check
/**
 * report.upload_missing: a stored report has no diagnostic bundle that downloads and parses from R2.
 *
 * The witnesses are in areas/report.json: `report.problem` rows are the population; the `report.upload.issue` and
 * `report.upload.complete` decisions and the `diagnostic_uploads` row are one witness; the client's `report.upload` op; and
 * `report.readback`, the checker's own GET, gunzip, JSON parse and identity match. An issued row never stored proves the client
 * never finished; a stored row the checker can't read back proves the store lost it. Rows without sdk_version are gaps, not old
 * clients to skip. The page_hidden expected waits for slice 9's pagehide records, which this registry does not have yet.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "report.upload_missing";

/** The client has this long after the report to ask for the upload. */
const ISSUE_MS = 30_000;
/** The API's presigned PUT window; a row not stored by then never completed. */
const STORE_MS = 120_000;
/** The first SDK that can upload a diagnostic bundle. */
const DIAGNOSTIC_UPLOAD_MIN_SDK_VERSION = "4.0.0";

export const settle_ms = 150_000;

export const healthy_absent = ["report.problem", "report.upload_issued", "report.upload_completed", "report.upload_row", "report.upload", "report.readback"];

export const expected = "every stored report on an upload-capable SDK gets one diagnostic_uploads row that reaches stored, and its bundle downloads and parses from R2";

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
  const problem = readings["report.problem"];
  if (problem.kind === "unknown") return { status: "unknown", reason: "the report source is not read" };
  if (problem.kind === "absent") return { status: "pass" };
  for (const name of ["report.upload_issued", "report.upload_completed", "report.upload_row"]) {
    if (readings[name].kind === "unknown") return { status: "unknown", reason: "the upload rows are not complete" };
  }
  const readbackRead = readings["report.readback"];
  if (readbackRead.kind === "unknown") return { status: "unknown", reason: "r2 is not read" };

  const issued = readings["report.upload_issued"].kind === "present" ? readings["report.upload_issued"].observations : [];
  const rows = readings["report.upload_row"].kind === "present" ? readings["report.upload_row"].observations : [];
  const readbacks = readbackRead.kind === "present" ? readbackRead.observations : [];
  const uploads = readings["report.upload"].kind === "present" ? readings["report.upload"].observations : [];

  for (const report of [...problem.observations].sort((a, b) => a.window.from_ms - b.window.from_ms)) {
    const sdk = report.value.sdk_version;
    if (sdk === undefined || sdk === null) return { status: "unknown", reason: "a report row has no sdk_version" };
    if (semverLt(String(sdk), DIAGNOSTIC_UPLOAD_MIN_SDK_VERSION)) continue;
    const created = typeof report.value.created_ms === "number" ? report.value.created_ms : report.window.from_ms;
    const row = rows.find((o) => o.value.report_id === report.value.report_id && o.value.upload_trigger === "report");
    if (row === undefined) {
      if (window.to_ms < created + ISSUE_MS) return { status: "unknown", reason: "the 30 s issue window has not run out" };
      const decide = issued.find((o) => o.value.report_id === report.value.report_id);
      return degraded(report, { from_ms: created, to_ms: created + ISSUE_MS }, "client", "sdk.diagnostics", "never_requested", "the client never asked for the upload", decide === undefined ? [] : [{ text: "report.upload.issue refused", evidence: [decide.id], window: decide.window, absent: null }]);
    }
    const issuedAt = typeof row.value.issued_ms === "number" ? row.value.issued_ms : row.window.from_ms;
    const op = uploads.find((o) => o.value.diagnostic_upload_id === row.value.diagnostic_upload_id);
    if (row.claim !== "stored") {
      if (row.claim === "issued" && window.to_ms < issuedAt + STORE_MS) return { status: "unknown", reason: "the upload is still inside its 120 s store window" };
      const module = op !== undefined && op.claim === "error" && op.value.reason_code === "report.network" ? "network" : "sdk.diagnostics";
      return degraded(report, { from_ms: issuedAt, to_ms: issuedAt + STORE_MS }, "client_upload", module, "not_uploaded", "upload issued, never stored", citeOp(op, row));
    }
    const readback = readbacks.find((o) => o.value.diagnostic_upload_id === row.value.diagnostic_upload_id);
    if (readback === undefined) return { status: "unknown", reason: "the checker never read the stored object back" };
    if (readback.claim !== "ok") {
      return degraded(report, row.window, "r2", "api.diagnosticuploads", "readback_failed", `the readback was ${readback.claim}`, [{ text: `R2 readback ${readback.claim}`, evidence: [readback.id], window: readback.window, absent: null }]);
    }
  }
  return { status: "pass" };
}

/** @param {Observation|undefined} op @param {Observation} row */
const citeOp = (op, row) => op === undefined
  ? [{ text: "upload issued, never stored", evidence: [row.id], window: row.window, absent: null }, { text: "no R2 object for the upload", evidence: [], window: null, absent: "report.readback" }]
  : [
      { text: "upload issued, never stored", evidence: [row.id], window: row.window, absent: null },
      { text: `report.upload error(${op.value.reason_code === "report.network" ? "network" : String(op.value.reason_code)})`, evidence: [op.id], window: op.window, absent: null },
      { text: "no R2 object for the upload", evidence: [], window: null, absent: "report.readback" },
    ];

/** @param {Observation} report @param {import("../../scripts/diagnose-call/proof/evidence.mjs").Window} window @param {string} hop @param {string} module @param {string} cause @param {string} observed @param {import("../../scripts/diagnose-call/proof/profile.mjs").Fact[]} extraFacts */
function degraded(report, window, hop, module, cause, observed, extraFacts) {
  return {
    status: "finding",
    outcome: "degraded",
    window,
    hop,
    module,
    reason: null,
    upstream: "unknown",
    observed: `${observed} (${cause})`,
    facts: [{ text: `report ${report.value.chk_code ?? report.value.report_id} stored`, evidence: [report.id], window: report.window, absent: null }, ...extraFacts],
    hypothesis: null,
    falsify: { absence: null, attribution: "a stored bundle that downloads and parses" },
  };
}
