// @ts-check
/**
 * boot.never_ran: Space documents were served to real browsers, but no script ran in any of them for a whole window. A page
 * whose scripts never run can't report itself, so the absence is proved by edge documents with zero boot.started on those
 * paths, a boot.started on them in the previous 24 h (the path can produce telemetry) and a same-build boot.started on any
 * path after the window (the client pipeline was live). A ratio above zero is never a finding.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "boot.never_ran";

const never_ran_min_visits = 20;
const never_ran_window_ms = 900_000;
const prior_window_ms = 24 * 3_600_000;

/** The Space-document paths the _headers patterns cover. */
const SPACE_PATH = "/:a-:b-:c";
/** entry_path values a Space document boot classifies as. */
const SPACE_ENTRIES = new Set(["space_public", "space_private", "space_open_signup", "space_dash_account"]);

export const expected = "every window of browser Space documents has at least one boot.started, or the client pipeline proves itself quiet";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "platform";

/** @param {Observation} o */
const isSpaceDoc = (o) => o.value.path_class === "space_page" && o.value.content_class === "html" && o.value.ua_class === "browser" && o.value.edge_status === 200;
/** @param {Observation} o */
const isSpaceStarted = (o) => SPACE_ENTRIES.has(/** @type {string} */ (o.claim));

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const docs = readings["boot.edge_documents"];
  const started = readings["boot.started"];
  if (docs.kind === "unknown") return { status: "unknown", reason: "edge unavailable" };
  if (docs.kind === "absent") return { status: "pass" };
  if (started.kind === "unknown") return { status: "unknown", reason: "client not live after the window" };
  const rows = docs.observations.filter(isSpaceDoc).sort((a, b) => /** @type {number} */ (a.value.window_start_ms) - /** @type {number} */ (b.value.window_start_ms));
  if (rows.length === 0) return { status: "pass" };
  const starts = started.kind === "present" ? started.observations : [];
  const spaceStarts = starts.filter(isSpaceStarted);
  const first = /** @type {number} */ (rows[0].value.window_start_ms);
  const last = /** @type {number} */ (rows[rows.length - 1].value.window_end_ms);
  for (let from = first; from < last; from += never_ran_window_ms) {
    const to = Math.min(from + never_ran_window_ms, last);
    const inWindow = rows.filter((o) => /** @type {number} */ (o.value.window_start_ms) >= from && /** @type {number} */ (o.value.window_start_ms) < to);
    const visits = inWindow.reduce((sum, o) => sum + /** @type {number} */ (o.value.request_count), 0);
    if (visits < never_ran_min_visits) continue;
    if (spaceStarts.some((o) => o.window.from_ms >= from && o.window.from_ms < to)) continue; // a ratio above zero is never a finding
    const window = { from_ms: from, to_ms: to };
    const prior = spaceStarts.find((o) => o.window.from_ms >= from - prior_window_ms && o.window.from_ms < from);
    const liveAfter = starts.filter((o) => o.window.from_ms >= to).sort((a, b) => a.window.from_ms - b.window.from_ms)[0];
    if (!liveAfter) return { status: "unknown", reason: "client not live after the window" };
    if (!prior) return { status: "unknown", reason: "no boot.started on those paths in the previous 24 h" };
    return {
      status: "finding",
      outcome: "broken",
      window,
      hop: "edge_document",
      module: "web.boot",
      reason: null,
      upstream: "witnessed",
      observed: `${visits} browser Space documents served and no script ran in any of them`,
      facts: [
        { text: `${visits} html 200 documents to browsers on ${SPACE_PATH}`, evidence: inWindow.map((o) => o.id), window, absent: null },
        { text: `no boot.started on ${SPACE_PATH} in the window`, evidence: [], window, absent: "boot.started" },
        { text: `boot.started on ${SPACE_PATH} in the previous 24 h`, evidence: [prior.id], window: prior.window, absent: null },
        { text: `boot.started of the same build on ${liveAfter.claim === "site" ? "/privacy" : liveAfter.claim} after the window`, evidence: [liveAfter.id], window: liveAfter.window, absent: null },
      ],
      hypothesis: { text: "the served document forbids scripts, such as a Content-Security-Policy that blocks every script", falsified_by: "a boot.started on those paths in the window" },
      falsify: { absence: "a boot.started on those paths in the window", attribution: "a build that differs from the one the live client ran" },
    };
  }
  return { status: "pass" };
}
