// @ts-check
/**
 * perf.device_overloaded: the OS reported serious thermal state or CPU pressure for 60 s or more during a live call.
 * An unsupported probe is itself a reading and leaves the seat unchecked, never healthy.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "perf.device_overloaded";
export const settle_ms = 120_000;
export const expected = "the device never reports serious thermal state or CPU pressure during the call";

const SUSTAINED_MS = 60_000;
const BAD = new Set(["serious", "critical", "severe", "emergency", "shutdown"]);

/** @param {DecideInput["declaration"]} declaration @param {DecideInput["seat"]} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings, window }) {
  const thermal = readings["perf.thermal"];
  if (thermal.kind === "unknown") return { status: "unknown", reason: "the seat's thermal probe is not witnessed" };
  const rows = thermal.kind === "present" ? thermal.observations : [];
  if (rows.length === 0) return { status: "pass" };
  if (rows.every((o) => o.claim === "unsupported")) return { status: "unknown", reason: "the thermal or pressure probe is unsupported on this platform" };
  const bad = rows.filter((o) => o.claim === "measured" && (BAD.has(String(o.value.thermal_state)) || BAD.has(String(o.value.cpu_pressure))));
  if (bad.length === 0) return { status: "pass" };
  // A serious state is sustained when two readings bracket 60 s of it, or one reading's state held to the window's end.
  const first = bad[0];
  const last = bad.at(-1);
  const sustained = last.window.from_ms - first.window.from_ms >= SUSTAINED_MS || window.to_ms - first.window.from_ms >= SUSTAINED_MS;
  if (!sustained) return { status: "pass" };
  const state = String(last.value.thermal_state ?? last.value.cpu_pressure);
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: first.window.from_ms, to_ms: last.window.to_ms },
    hop: "device_thermal",
    module: "rn.app_health",
    reason: null,
    upstream: "witnessed",
    observed: `the device reported ${state} for a minute or more during the call`,
    facts: [{ text: `thermal or pressure readings at ${state}: ${bad.length}`, evidence: bad.map((o) => o.id), window: { from_ms: first.window.from_ms, to_ms: last.window.to_ms }, absent: null }],
    hypothesis: { text: "the device was thermally saturated under the call", falsified_by: "probe readings that never reach serious for a sustained minute" },
    falsify: { absence: null, attribution: "a complete call whose probe stayed below serious" },
  };
}
