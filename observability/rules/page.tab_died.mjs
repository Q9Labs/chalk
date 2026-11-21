// @ts-check
/**
 * page.tab_died: the browser tab died during a live call without pagehide, found on the next run from its run marker.
 *
 * A dead web marker (no clean_exit, phase joining/live/reconnecting) plus Sync's close of the dead seat's socket names the
 * death. A normal close or a marker with clean_exit means the run left by its own hand. The dead run cannot report itself,
 * so the finding lands on the seat that reported its marker.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
import { closesBySeatHash, deadMarkers, hashParticipant } from "./crash-helpers.mjs";

export const symptom = "page.tab_died";
export const settle_ms = 120_000;
export const expected = "every tab that joined a call either leaves cleanly or reports its own end; no marker names a dead run";

/** @param {DecideInput["declaration"]} declaration @param {DecideInput["seat"]} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings, declaration, seat }) {
  const scan = readings["app.marker_scan"];
  const closes = readings["page.tab_close"];
  const previous = readings["app.previous_run"];
  if (scan.kind === "unknown") return { status: "unknown", reason: "the seat's marker scan is not witnessed" };
  if (scan.kind === "absent") return { status: "unknown", reason: "the seat's client never ran previous_run.read" };
  if (closes.kind === "unknown") return { status: "unknown", reason: "Sync's close rows are not witnessed" };
  const dead = deadMarkers(previous).filter((o) => o.value.phase !== "launch");
  if (dead.length === 0) return scan.kind === "present" && closes.kind !== "unknown" ? { status: "pass" } : { status: "unknown", reason: "no dead marker, and the scans or closes are not witnessed" };
  const marker = dead[0];
  if (closes.kind !== "present") return { status: "unknown", reason: "a dead marker was found but Sync's closes are not witnessed" };
  const byHash = closesBySeatHash(closes);
  const seats = declaration.kind === "episode" ? declaration.seats : [];
  const deadSeat = seats.find((s) => (byHash.get(hashParticipant(s.participant)) ?? []).length > 0);
  const close = deadSeat === undefined ? undefined : byHash.get(hashParticipant(deadSeat.participant))?.find((o) => o.claim !== "normal" && o.claim !== "client_closed") ?? byHash.get(hashParticipant(deadSeat.participant))?.[0];
  if (close === undefined || close.claim === "normal" || close.claim === "client_closed") {
    return { status: "unknown", reason: "a marker names a dead run but Sync saw no abnormal close for it" };
  }
  const cs = String(marker.value.previous_client_session_id);
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: Math.min(marker.window.from_ms, close.window.from_ms), to_ms: Math.max(marker.window.to_ms, close.window.to_ms) },
    hop: "client_tab",
    module: "web.space_call",
    reason: null,
    upstream: "witnessed",
    observed: `the tab died during the call: run ${cs} left a marker with no clean exit and Sync closed ${deadSeat?.participant ?? "its seat"} abnormally (${close.claim})`,
    facts: [
      { text: `a run marker for ${cs} shows no clean exit (phase ${marker.value.phase})`, evidence: [marker.id], window: marker.window, absent: null },
      { text: `Sync closed the dead seat's socket: ${close.claim}${close.value.heartbeat_gap_ms !== undefined ? `, heartbeat silent ${close.value.heartbeat_gap_ms} ms` : ""}`, evidence: [close.id], window: close.window, absent: null },
    ],
    hypothesis: { text: "the renderer process died without pagehide (crash, out of memory or a kill)", falsified_by: "a marker showing a clean exit, or Sync closing the socket normally" },
    falsify: { absence: null, attribution: "a clean exit marker for the dead run, or a normal Sync close" },
  };
}
