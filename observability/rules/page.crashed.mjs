// @ts-check
/**
 * page.crashed: the web call page threw during render and showed the crash fallback, or a lazy chunk failed mid-call.
 *
 * The witnesses are in areas/crash.json: `perf.heartbeat` (required, proves the build reports slice 9 evidence across the
 * seat's live span), `page.render_crash` and `page.crash_surface`. A crash is a render_error claim or any report whose
 * error_class is chunk_load. The fallback surface is cited for impact only; it is never a second witness of the crash.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "page.crashed";
export const settle_ms = 120_000;
export const expected = "the call page renders without a render error and no lazy chunk fails mid-call";

/** @param {DecideInput["declaration"]} declaration @param {DecideInput["seat"]} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const heartbeat = readings["perf.heartbeat"];
  const crashes = readings["page.render_crash"];
  const surface = readings["page.crash_surface"];
  if (heartbeat.kind !== "present") return { status: "unknown", reason: "the seat's client evidence is not witnessed" };
  if (crashes.kind !== "present") return { status: "pass" };
  const crash = crashes.observations.find((o) => o.claim === "render_error" || o.value.error_class === "chunk_load");
  if (crash === undefined) return { status: "pass" };
  const chunkLoad = crash.value.error_class === "chunk_load" && crash.claim !== "render_error";
  const shown = surface.kind === "present" ? surface.observations.find((o) => o.claim === "shown") : undefined;
  const facts = [
    { text: `the client reported a page crash: ${crash.claim}${crash.value.error_class === "chunk_load" ? " (a lazy chunk failed to load)" : ""}`, evidence: [crash.id], window: crash.window, absent: null },
  ];
  if (shown !== undefined) facts.push({ text: "the crash fallback was shown and seen", evidence: [shown.id], window: shown.window, absent: null });
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: crash.window.from_ms, to_ms: crash.window.to_ms },
    hop: "client_render",
    module: chunkLoad ? "react.device_popover" : "web.space_call",
    reason: null,
    upstream: "witnessed",
    observed: `the call page crashed (${crash.claim}${crash.value.error_name !== undefined ? `, ${crash.value.error_name}` : ""})`,
    facts,
    hypothesis: chunkLoad ? { text: "a lazy module failed to load during the call", falsified_by: "the chunk loading in a re-run" } : { text: "a render threw inside the call tree", falsified_by: "the render succeeding in a re-run" },
    falsify: { absence: null, attribution: "a complete call with no render error and no failed lazy chunk" },
  };
}
