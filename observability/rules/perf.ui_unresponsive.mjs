// @ts-check
/**
 * perf.ui_unresponsive: the web main thread or the React Native JS thread was blocked 1000 ms or more while the call was
 * on screen. Hidden and background windows are skipped. A frozen worker (late as long as the main thread) is a suspended
 * process, not a UI stall. Missing heartbeats are a gap, never "no stalls".
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "perf.ui_unresponsive";
export const settle_ms = 120_000;
export const expected = "no 30 s window while the call is on screen blocks the main or JS thread for a second or more";

const STALL_MS = 1000;

/** @param {DecideInput["declaration"]} declaration @param {DecideInput["seat"]} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const heartbeat = readings["perf.heartbeat"];
  if (heartbeat.kind !== "present") return { status: "unknown", reason: "the seat's heartbeat windows are not witnessed" };
  const onScreen = heartbeat.observations.filter((o) => o.value.visibility !== "hidden" && (o.value.app_state === undefined || o.value.app_state === "active"));
  const stalls = onScreen.filter((o) => Number(o.value.long_task_max_ms_30s ?? 0) >= STALL_MS || Number(o.value.main_ping_max_ms_30s ?? 0) >= STALL_MS || Number(o.value.js_lag_max_ms_30s ?? 0) >= STALL_MS);
  if (stalls.length === 0) return { status: "pass" };
  const worst = stalls.reduce((a, b) => (Math.max(Number(b.value.long_task_max_ms_30s ?? 0), Number(b.value.main_ping_max_ms_30s ?? 0), Number(b.value.js_lag_max_ms_30s ?? 0)) > Math.max(Number(a.value.long_task_max_ms_30s ?? 0), Number(a.value.main_ping_max_ms_30s ?? 0), Number(a.value.js_lag_max_ms_30s ?? 0)) ? b : a));
  const worstStall = Math.max(Number(worst.value.long_task_max_ms_30s ?? 0), Number(worst.value.main_ping_max_ms_30s ?? 0), Number(worst.value.js_lag_max_ms_30s ?? 0));
  const workerLate = Number(worst.value.worker_late_max_ms_30s ?? 0);
  if (workerLate >= worstStall && Number(worst.value.js_lag_max_ms_30s ?? 0) < STALL_MS) {
    return { status: "finding", outcome: "expected", window: worst.window, hop: "client_main", module: "web.space_call", reason: "perf.process_suspended", upstream: "witnessed", observed: `the whole process was suspended ${Math.round(workerLate)} ms, which no main-thread bug can cause`, facts: [{ text: `worker tick ran ${Math.round(workerLate)} ms late in the same window the ping measured ${Math.round(worstStall)} ms`, evidence: [worst.id], window: worst.window, absent: null }], hypothesis: null, falsify: { absence: null, attribution: "a stall where the worker's own tick stayed on time" } };
  }
  const first = stalls[0];
  const last = stalls.at(-1);
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: first.window.from_ms, to_ms: last.window.to_ms },
    hop: "client_main",
    module: worst.value.js_lag_max_ms_30s !== undefined ? "rn.app_health" : "web.space_call",
    reason: null,
    upstream: "witnessed",
    observed: `the ${worst.value.js_lag_max_ms_30s !== undefined ? "JS" : "main"} thread was blocked ${Math.round(worstStall)} ms across ${stalls.length} window${stalls.length === 1 ? "" : "s"}`,
    facts: [{ text: `heartbeat windows with stalls: worst ${Math.round(worstStall)} ms of ${stalls.length}`, evidence: stalls.map((o) => o.id), window: { from_ms: first.window.from_ms, to_ms: last.window.to_ms }, absent: null }],
    hypothesis: { text: "the render thread was blocked while the call was on screen", falsified_by: "windows where the worker's own tick froze as long, i.e. a suspended process" },
    falsify: { absence: null, attribution: "a complete call with no on-screen window blocked a second or more" },
  };
}
