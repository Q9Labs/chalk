// @ts-check
// Runs the diagnose CLI over the 18 Nov world for the output tests, judging only the foundation's checks.
import assert from "node:assert/strict";
import { run } from "../diagnose.mjs";
import { CATALOGUE } from "../proof/catalogue.mjs";
import { rulesVersion } from "../proof/verdict.mjs";

/** The checks the CLI contract goldens judge. A slice's check is proved by its own fixtures and never joins this list. */
const FOUNDATION = ["admission.unresolved", "audio.not_heard", "board.view_jumped", "end.time_limit", "end.wrong_screen", "recording.not_ready"];

/** @param {readonly import("../proof/profile.mjs").CheckDef[]} catalogue */
export function goldenChecks(catalogue) {
  const picked = catalogue.filter((def) => FOUNDATION.includes(def.code));
  return { catalogue: picked, rules: rulesVersion(picked, []) };
}

const GOLDEN_CHECKS = goldenChecks(CATALOGUE);

/** @param {string[]} argv @param {ReturnType<typeof goldenChecks>} [checks] */
export async function diagnose(argv, checks = GOLDEN_CHECKS) {
  const result = await run([...argv, "--fixture", "nov18"], { checks });
  assert.equal(result.err, "", `diagnose ${argv.join(" ")} wrote to stderr`);
  return result;
}

/** @type {Record<string, string[]>} */
export const GOLDENS = {
  "episode-9feb": ["ep_9feb"],
  "evidence-no-voice": ["evidence", "f_5b55"],
  "day-th": ["day", "TH", "2026-11-18"],
  "check-th": ["check", "TH", "2026-11-18"],
  "participant-haris": ["participant", "usr_th-1041"],
  "pattern-no-voice": ["pattern", "audio.not_heard", "--tenant", "TH"],
  "resolve-haris": ["Haris"],
  "attempt-unresolved": ["attempt", "cs_6d5e"],
  "space-day": ["space", "spc_5bac", "2026-11-18"],
  "tenant-day": ["tenant", "ten_1f0c", "2026-11-18"],
  "platform-day": ["platform", "production", "2026-11-18"],
  "job-recording": ["job", "job_4a3b"],
};
