// @ts-check
/**
 * app.killed_in_background: the OS or the user ended the native app while it was backgrounded or inactive during a call.
 *
 * The marker's last app_state tells where the run died; the OS exit reason tells who ended it. A user-requested reason is
 * expected, an OS kill or a crash while backgrounded is broken. will_terminate never means the user closed the app.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
import { closesBySeatHash, CRASH_EXITS, deadMarkers, hashParticipant, NO_ANSWER_EXITS, OS_KILLS, USER_EXITS } from "./crash-helpers.mjs";

export const symptom = "app.killed_in_background";
export const settle_ms = 120_000;
export const expected = "a backgrounded app keeps its marker current until the call ends or the person leaves";

/** @param {DecideInput["declaration"]} declaration @param {DecideInput["seat"]} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings, declaration, seat }) {
  const scan = readings["app.marker_scan"];
  const closes = readings["page.tab_close"];
  const previous = readings["app.previous_run"];
  const exits = readings["app.process_exit"];
  if (scan.kind !== "present") return { status: "unknown", reason: "the seat's marker scan is not witnessed" };
  if (closes.kind === "unknown") return { status: "unknown", reason: "Sync's close rows are not witnessed" };

  const dead = deadMarkers(previous).filter((o) => o.value.app_state === "background" || o.value.app_state === "inactive");
  const exit = exits.kind === "present" ? exits.observations[0] : undefined;
  if (dead.length === 0) return { status: "pass" };
  const marker = dead[0];

  const byHash = closesBySeatHash(closes);
  const seats = declaration.kind === "episode" ? declaration.seats : [];
  const deadSeat = seats.filter((s) => s.participant !== seat?.participant).find((s) => (byHash.get(hashParticipant(s.participant)) ?? []).length > 0);
  const close = deadSeat === undefined ? undefined : byHash.get(hashParticipant(deadSeat.participant))?.[0];

  const facts = [{ text: `a run marker shows the dead run ${marker.value.app_state} with no clean exit`, evidence: [marker.id], window: marker.window, absent: null }];
  if (exit !== undefined) facts.push({ text: `the OS exit reason is ${exit.claim}`, evidence: [exit.id], window: exit.window, absent: null });
  if (close !== undefined) facts.push({ text: `Sync closed the dead seat's socket: ${close.claim}`, evidence: [close.id], window: close.window, absent: null });

  const reason = exit === undefined ? undefined : String(exit.claim);
  const userClosed = reason !== undefined && USER_EXITS.has(reason);
  const noAnswer = reason === undefined || NO_ANSWER_EXITS.has(reason);
  if (noAnswer) return { status: "unknown", reason: "a backgrounded dead marker was found but the OS has no exit reason" };
  const osKilled = OS_KILLS.has(reason) || CRASH_EXITS.has(reason);
  return {
    status: "finding",
    outcome: userClosed ? "expected" : "broken",
    window: { from_ms: Math.min(marker.window.from_ms, close?.window.from_ms ?? marker.window.from_ms), to_ms: Math.max(marker.window.to_ms, close?.window.to_ms ?? marker.window.to_ms, exit?.window.to_ms ?? marker.window.to_ms) },
    hop: "device_exit",
    module: "rn.app_health",
    reason: userClosed ? "app.user_closed_app" : null,
    upstream: "witnessed",
    observed: `the app died while ${marker.value.app_state} during the call, OS reason ${reason}`,
    facts,
    hypothesis: userClosed ? null : { text: osKilled ? "the OS reclaimed the backgrounded app" : "the app was ended while backgrounded", falsified_by: "an OS reason of user-requested or a clean-exit marker" },
    falsify: { absence: null, attribution: "an OS reason of user-requested, or the run reaching the call's end backgrounded but alive" },
  };
}
