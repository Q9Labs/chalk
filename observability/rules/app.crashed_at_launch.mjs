// @ts-check
/**
 * app.crashed_at_launch: the native app died at launch before its JS ran, found on a later launch from the launch marker.
 *
 * The marker says phase=launch, js_ready=false; the OS exit info (Android ApplicationExitInfo or iOS MetricKit) says why.
 * No Space, Sync or DB witness can exist when JS never reached a Space. No exit reason is unknown, never healthy.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
import { CRASH_EXITS, deadMarkers, NO_ANSWER_EXITS, OS_KILLS, USER_EXITS } from "./crash-helpers.mjs";

export const symptom = "app.crashed_at_launch";
export const settle_ms = 0;
export const expected = "every launch reaches JS, or the OS explains a death that is not a crash";

/** @param {DecideInput["declaration"]} declaration @param {DecideInput["seat"]} seat */
export const applies = (declaration, seat) => declaration.kind === "attempt";

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const scan = readings["app.marker_scan"];
  const exits = readings["app.process_exit"];
  const previous = readings["app.previous_run"];
  if (scan.kind !== "present") return { status: "unknown", reason: "the launch's marker scan is not witnessed" };
  const launch = deadMarkers(previous).find((o) => o.value.phase === "launch" && o.value.js_ready === false);
  if (launch === undefined) return { status: "pass" };
  if (exits.kind !== "present") return { status: "unknown", reason: "a launch marker was found but the OS's exit reason is not witnessed" };
  const exit = exits.observations[0];
  const reason = String(exit.claim);
  if (NO_ANSWER_EXITS.has(reason)) return { status: "unknown", reason: `the OS has no exit reason for the dead launch (${reason})` };
  const facts = [
    { text: "a launch marker shows phase=launch, js_ready=false", evidence: [launch.id], window: launch.window, absent: null },
    { text: `the OS exit reason is ${reason}`, evidence: [exit.id], window: exit.window, absent: null },
  ];
  if (USER_EXITS.has(reason)) {
    return { status: "finding", outcome: "expected", window: launch.window, hop: "device_launch", module: "rn.app_health", reason: "app.user_closed_app", upstream: "witnessed", observed: `the OS says the person ended the launch (${reason})`, facts, hypothesis: null, falsify: { absence: null, attribution: "a crash-class OS reason for the same launch" } };
  }
  const crash = CRASH_EXITS.has(reason) || OS_KILLS.has(reason);
  return {
    status: "finding",
    outcome: crash ? "broken" : "expected",
    window: { from_ms: Math.min(launch.window.from_ms, exit.window.from_ms), to_ms: Math.max(launch.window.to_ms, exit.window.to_ms) },
    hop: "device_launch",
    module: "rn.app_health",
    reason: crash ? null : "app.os_ended_launch",
    upstream: "witnessed",
    observed: `the app died at launch before JS ran, OS reason ${reason}`,
    facts,
    hypothesis: crash ? { text: "the process died during startup before React Native loaded", falsified_by: "an OS reason naming a user action or a marker with js_ready=true" } : null,
    falsify: { absence: null, attribution: "an OS reason naming a user action or non-crash system reclaim" },
  };
}
