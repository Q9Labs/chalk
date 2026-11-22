#!/usr/bin/env node
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
// pnpm diagnose:call <episode id> [--fixture rows.json] [--strict]
// Reads the database (including the durable media session and plane change tables, which outlive Axiom), Axiom (API, client, SFU node,
// recorder) and the Sync traces for one Episode, joins every row by id, and prints what happened to each Participant, what went wrong,
// on whose side, and which rows prove it.
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { buildCall, mediaPlane } from "./call.mjs";
import { gapsOf } from "./gaps.mjs";
import { joinByIds } from "./join.mjs";
import { render } from "./render.mjs";
import { normalizeRow } from "./rows.mjs";
import { findingsOf } from "./rules.mjs";
import { readSources } from "./sources.mjs";
import { timelines } from "./timeline.mjs";
import { unmuteLines, unmutesOf } from "./unmute.mjs";
import { verdictLine } from "./verdict.mjs";

export const thresholds = JSON.parse(readFileSync(new URL("../../infrastructure/observability/production-alerts/call-verdict.json", import.meta.url), "utf8"));
const EPISODE_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const USAGE = `usage: pnpm diagnose:call <episode id> [--fixture rows.json] [--strict]
environment:
  AXIOM_TOKEN            Axiom query token (required)
  AXIOM_ORG_ID           Axiom organisation id (required by personal tokens)
  CHALK_LOG_DATASET      the log dataset (required)
  CHALK_TRACE_DATASET    the trace dataset with Sync spans (default chalk-prod-traces); a token that cannot read it makes Sync a missing source
  CHALK_DATABASE_URL     a read-only database URL; without it Participants, leave reasons, leases and the durable media session outcomes are a missing source
--strict exits 3 when a bad call is found, 2 when evidence is missing and nothing bad was found, and 0 otherwise.`;

/** Diagnoses one Episode from already-read rows; the command and the tests share it. */
export function diagnoseRows(episodeId, rows, sourceGaps = []) {
  const { joined, unjoined, stats } = joinByIds(episodeId, rows);
  const call = buildCall(joined);
  const findings = findingsOf(call, thresholds);
  const gaps = gapsOf(call, sourceGaps, unjoined.length);
  const unmutes = unmutesOf(call);
  return { episodeId, plane: mediaPlane(call), unmutes, unmuteSummary: unmuteLines(unmutes, thresholds), verdict: verdictLine(findings, gaps, call), findings, gaps, stats, timeline: timelines(call, findings), unjoined };
}

/** 3 when a bad call was found, 2 when something that could hide one is missing, else 0. */
export function strictCode({ findings, gaps }) {
  if (findings.some((finding) => !finding.benign)) return 3;
  return gaps.some((gap) => gap.blocks) ? 2 : 0;
}

export async function main(argv, env = process.env) {
  const started = Date.now();
  const fixtureAt = argv.indexOf("--fixture");
  const episodeId = argv.find((arg, at) => !arg.startsWith("--") && (fixtureAt < 0 || at !== fixtureAt + 1));
  if (!episodeId || !EPISODE_ID.test(episodeId)) {
    console.error(USAGE);
    return 64;
  }
  const source = fixtureAt >= 0 ? { rows: JSON.parse(await readFile(argv[fixtureAt + 1], "utf8")).map((row) => normalizeRow(row)), gaps: [] } : await readSources({ episodeId, env, databaseDays: thresholds.database_window_days, axiomDays: thresholds.axiom_retention_days });
  const result = diagnoseRows(episodeId, source.rows, source.gaps);
  console.log(render({ ...result, elapsedMs: Date.now() - started }));
  return argv.includes("--strict") ? strictCode(result) : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
