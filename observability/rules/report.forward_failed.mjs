// @ts-check
/**
 * report.forward_failed: the report is stored, but the Discord forward failed or never finished.
 *
 * The witnesses are in areas/report.json: `report.problem` (the row's forward_outcome), `report.forward` (the API's forward op,
 * typed from DeliveryError) and `report.config` (the boot fact saying whether forwarding was configured for that release_sha).
 * The row and the op are one witness, since nobody reads Discord's channel. A `pending` outcome past the 60 s mark, or a
 * `not_configured` row while the boot fact says forwarding=true, is the finding; `not_configured` with forwarding=false passes.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "report.forward_failed";

/** A forward left pending this long proves the API never wrote the outcome back. */
const PENDING_MS = 60_000;

export const settle_ms = PENDING_MS;

export const healthy_absent = ["report.problem", "report.forward", "report.config"];

export const expected = "every stored report's forward finishes: ok when the channel accepts it, or not_configured while the boot fact says forwarding is off";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const problem = readings["report.problem"];
  const forward = readings["report.forward"];
  const config = readings["report.config"];

  if (problem.kind === "unknown") return { status: "unknown", reason: "the report source is not read" };
  if (problem.kind === "absent") return { status: "pass" };
  if (forward.kind === "unknown") return { status: "unknown", reason: "the api forward evidence is incomplete" };

  const forwards = forward.kind === "present" ? forward.observations : [];
  const configObs = config.kind === "present" ? config.observations : [];
  const reportId = (o) => o.value.report_id;
  const forwardFor = (row) => forwards.find((o) => reportId(o) === reportId(row));

  for (const row of [...problem.observations].sort((a, b) => a.window.from_ms - b.window.from_ms)) {
    const outcome = String(row.value.forward_outcome ?? "pending");
    const op = forwardFor(row);
    if (outcome.startsWith("http_") || outcome.startsWith("transport_")) {
      return degraded(row, outcome, op, `report ${row.value.chk_code ?? row.value.report_id} stored, forward answered ${outcome}`);
    }
    if (outcome === "ok") continue;
    // pending or not_configured: the boot fact for the row's release decides.
    if (configObs.length === 0) return { status: "unknown", reason: `the row's forward_outcome is ${outcome} and no api boot fact is read` };
    const release = typeof row.value.release_sha === "string" ? row.value.release_sha : null;
    const boot = release === null ? configObs[configObs.length - 1] : (configObs.find((o) => o.value.release_sha === release) ?? configObs[configObs.length - 1]);
    const forwarding = boot.claim === "true" || boot.value.forwarding === true;
    if (outcome === "not_configured") {
      if (!forwarding) continue;
      return degraded(row, outcome, op, `the row says not_configured while the boot fact says forwarding=true (config_mismatch)`, boot);
    }
    const created = typeof row.value.created_ms === "number" ? row.value.created_ms : row.window.from_ms;
    if (row.window.to_ms >= created + PENDING_MS) {
      return degraded(row, outcome, op, `the forward stayed pending past ${PENDING_MS / 1000} s after the commit`);
    }
    if (config.kind === "unknown") return { status: "unknown", reason: "the api boot fact is not read" };
  }
  return { status: "pass" };
}

/** @param {Observation} row @param {string} outcome @param {Observation|undefined} op @param {string} observed @param {Observation} [boot] */
function degraded(row, outcome, op, observed, boot) {
  const facts = [
    { text: `report ${row.value.chk_code ?? row.value.report_id} stored`, evidence: [row.id], window: row.window, absent: null },
  ];
  if (op !== undefined) facts.push({ text: `problem_report.forward error(${outcome})`, evidence: [op.id], window: op.window, absent: null });
  if (boot !== undefined) facts.push({ text: "problem_reports.config forwarding=true", evidence: [boot.id], window: boot.window, absent: null });
  return {
    status: "finding",
    outcome: "degraded",
    window: row.window,
    hop: "api_forward",
    module: "api.discordreports",
    reason: null,
    upstream: "unknown",
    observed,
    facts,
    hypothesis: null,
    falsify: { absence: null, attribution: "a forward_outcome of ok on the row" },
  };
}
