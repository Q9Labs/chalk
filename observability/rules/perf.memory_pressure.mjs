// @ts-check
/**
 * perf.memory_pressure: the web heap grew 300 MiB over its baseline or reached 90% of its limit, or the OS reported low
 * memory, during a live call. An unsupported probe is unavailable, never zero and never healthy.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "perf.memory_pressure";
export const settle_ms = 120_000;
export const expected = "the heap stays within its limit and the OS never reports low memory during the call";

const GROWTH_MIB = 300;
const LIMIT_FRACTION = 0.9;
/** memory_warning rows claim the app_state at warning; heartbeat rows claim ok/low/measured/unsupported. */
const WARNING_CLAIMS = new Set(["active", "inactive", "background"]);

/** @param {DecideInput["declaration"]} declaration @param {DecideInput["seat"]} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const memory = readings["perf.memory"];
  const heartbeat = readings["perf.heartbeat"];
  if (heartbeat.kind !== "present") return { status: "unknown", reason: "the seat's heartbeat windows are not witnessed" };
  if (memory.kind === "unknown") return { status: "unknown", reason: "the seat's memory readings are not witnessed" };

  const rows = memory.kind === "present" ? memory.observations : [];
  const warnings = rows.filter((o) => o.claim === "low" || WARNING_CLAIMS.has(String(o.claim)));
  if (warnings.length > 0) {
    const first = warnings[0];
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: first.window.from_ms, to_ms: warnings.at(-1).window.to_ms },
      hop: "client_memory",
      module: "rn.app_health",
      reason: null,
      upstream: "witnessed",
      observed: "the OS reported low memory during the call",
      facts: [{ text: `low-memory reports: ${warnings.length}`, evidence: warnings.map((o) => o.id), window: { from_ms: first.window.from_ms, to_ms: warnings.at(-1).window.to_ms }, absent: null }],
      hypothesis: { text: "the OS was reclaiming memory under the call", falsified_by: "a complete call with no memory warning and no low-memory state" },
      falsify: { absence: null, attribution: "a complete call with no low-memory report" },
    };
  }

  const heapRows = heartbeat.observations.filter((o) => o.value.heap_probe === "measured" && typeof o.value.heap_used_mib === "number");
  if (heapRows.length === 0) {
    return rows.length > 0 && rows.every((o) => o.claim === "unsupported") ? { status: "unknown", reason: "the memory probe is unsupported on this platform" } : { status: "pass" };
  }
  const baseline = heapRows[0].value.heap_used_mib;
  const overLimit = heapRows.filter((o) => typeof o.value.heap_limit_mib === "number" && o.value.heap_limit_mib > 0 && o.value.heap_used_mib / o.value.heap_limit_mib >= LIMIT_FRACTION);
  const grown = heapRows.filter((o) => o.value.heap_used_mib - baseline >= GROWTH_MIB);
  const suspicious = [...new Set([...overLimit, ...grown])];
  if (suspicious.length === 0) return { status: "pass" };
  const worst = suspicious.reduce((a, b) => (b.value.heap_used_mib > a.value.heap_used_mib ? b : a));
  const why = overLimit.includes(worst) ? `reached ${Math.round((worst.value.heap_used_mib / worst.value.heap_limit_mib) * 100)}% of its ${Math.round(worst.value.heap_limit_mib)} MiB limit` : `grew ${Math.round(worst.value.heap_used_mib - baseline)} MiB over its baseline`;
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: suspicious[0].window.from_ms, to_ms: suspicious.at(-1).window.to_ms },
    hop: "client_memory",
    module: "web.space_call",
    reason: null,
    upstream: "witnessed",
    observed: `the heap ${why}`,
    facts: [{ text: `heap ${why} (used ${worst.value.heap_used_mib} MiB)`, evidence: suspicious.map((o) => o.id), window: { from_ms: suspicious[0].window.from_ms, to_ms: suspicious.at(-1).window.to_ms }, absent: null }],
    hypothesis: { text: "memory pressure built under the call until the tab or the OS acted", falsified_by: "heap windows that stay below both thresholds" },
    falsify: { absence: null, attribution: "a complete call whose heap stayed below growth and limit thresholds" },
  };
}
