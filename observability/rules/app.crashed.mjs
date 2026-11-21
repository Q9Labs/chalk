// @ts-check
/**
 * app.crashed: the native app died in the foreground during a live call: a JS fatal, a native render crash, an OS crash,
 * an ANR or a foreground OOM kill.
 *
 * The witnesses are in areas/crash.json: the dead run's marker, a JS fatal the dying run recorded itself, the OS exit
 * reason and Sync's close of the dead seat's socket. A marker with clean_exit, or an OS reason of user-requested, means
 * the run left by the person's hand.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
import { closesBySeatHash, CRASH_EXITS, deadMarkers, hashParticipant, OS_KILLS, USER_EXITS } from "./crash-helpers.mjs";

export const symptom = "app.crashed";
export const settle_ms = 120_000;
export const expected = "the app stays alive through the call or the person ends it themselves; no dead foreground run is found";

/** @param {DecideInput["declaration"]} declaration @param {DecideInput["seat"]} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings, declaration, seat }) {
  const scan = readings["app.marker_scan"];
  const closes = readings["page.tab_close"];
  const previous = readings["app.previous_run"];
  const fatals = readings["app.js_fatal"];
  const exits = readings["app.process_exit"];
  if (scan.kind !== "present") return { status: "unknown", reason: "the seat's marker scan is not witnessed" };
  if (closes.kind === "unknown") return { status: "unknown", reason: "Sync's close rows are not witnessed" };

  const dead = deadMarkers(previous).filter((o) => o.value.phase !== "launch" && (o.value.app_state === undefined || o.value.app_state === "active"));
  const fatal = fatals.kind === "present" ? fatals.observations[0] : undefined;
  const exit = exits.kind === "present" ? exits.observations[0] : undefined;
  const userClosed = exit !== undefined && USER_EXITS.has(String(exit.claim));
  if (userClosed && fatal === undefined && dead.length === 0) {
    return { status: "finding", outcome: "expected", window: exit.window, hop: "device_exit", module: "rn.app_health", reason: "app.user_closed_app", upstream: "witnessed", observed: `the OS says the person ended the app (${exit.claim})`, facts: [{ text: `the OS exit reason is ${exit.claim}`, evidence: [exit.id], window: exit.window, absent: null }], hypothesis: null, falsify: { absence: null, attribution: "a dead-run marker or a JS fatal for the same end" } };
  }
  if (dead.length === 0 && fatal === undefined && !(exit !== undefined && (CRASH_EXITS.has(String(exit.claim)) || OS_KILLS.has(String(exit.claim))))) return { status: "pass" };
  if (closes.kind !== "present" && dead.length > 0) return { status: "unknown", reason: "a dead marker was found but Sync's closes are not witnessed" };

  const byHash = closesBySeatHash(closes);
  const seats = declaration.kind === "episode" ? declaration.seats : [];
  const deadSeat = seats.filter((s) => s.participant !== seat?.participant).find((s) => (byHash.get(hashParticipant(s.participant)) ?? []).length > 0);
  const close = deadSeat === undefined ? undefined : byHash.get(hashParticipant(deadSeat.participant))?.[0];

  const facts = [];
  const marker = dead[0];
  if (marker !== undefined) facts.push({ text: `a run marker for ${String(marker.value.previous_client_session_id ?? "the dead run")} shows no clean exit (${marker.value.app_state ?? "foreground"}, phase ${marker.value.phase})`, evidence: [marker.id], window: marker.window, absent: null });
  if (fatal !== undefined) facts.push({ text: `the dying run recorded a fatal JS error (${fatal.value.error_name ?? fatal.claim})`, evidence: [fatal.id], window: fatal.window, absent: null });
  if (exit !== undefined) facts.push({ text: `the OS exit reason is ${exit.claim}`, evidence: [exit.id], window: exit.window, absent: null });
  if (close !== undefined) facts.push({ text: `Sync closed the dead seat's socket: ${close.claim}`, evidence: [close.id], window: close.window, absent: null });
  const first = [marker?.window.from_ms, fatal?.window.from_ms, close?.window.from_ms].filter((v) => v !== undefined).sort((a, b) => a - b)[0] ?? exit?.window.from_ms;
  const last = [marker?.window.to_ms, fatal?.window.to_ms, close?.window.to_ms, exit?.window.to_ms].filter((v) => v !== undefined).sort((a, b) => b - a)[0];
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: first, to_ms: last },
    hop: fatal !== undefined ? "client_fatal" : "device_exit",
    module: "rn.app_health",
    reason: null,
    upstream: "witnessed",
    observed: `the app died in the foreground during the call${fatal !== undefined ? ` (${fatal.value.error_name ?? fatal.claim})` : ""}${exit !== undefined ? `, OS reason ${exit.claim}` : ""}`,
    facts,
    hypothesis: { text: "the process died in the foreground: a JS fatal, a native crash, an ANR or a foreground OOM kill", falsified_by: "an OS reason of user-requested, or a marker with a clean exit" },
    falsify: { absence: null, attribution: "an OS exit of user-requested or a clean-exit marker for the dead run" },
  };
}
