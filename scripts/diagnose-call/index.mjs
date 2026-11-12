#!/usr/bin/env node
// pnpm diagnose:call <episode id> [--fixture rows.json] [--strict]
// Reads Axiom (API, client, SFU node, Sync) and the database for one Episode, joins every row by id, and prints a verdict.
// Needs AXIOM_TOKEN and CHALK_LOG_DATASET; CHALK_TRACE_DATASET (Sync spans) and CHALK_DATABASE_URL (Participants) are optional.
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { joinByIds } from "./join.mjs";
import { render } from "./render.mjs";
import { normalizeRow } from "./rows.mjs";
import { readSources } from "./sources.mjs";
import { diagnose } from "./verdict.mjs";

export const thresholds = JSON.parse(readFileSync(new URL("../../infrastructure/observability/production-alerts/call-verdict.json", import.meta.url), "utf8"));
const EPISODE_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Diagnoses one Episode from already-read rows; the command and the tests share it. */
export function diagnoseRows(episodeId, rows, extra = {}) {
  const { joined, unjoined, stats } = joinByIds(episodeId, rows);
  const { findings, missing } = diagnose(joined, thresholds);
  return { episodeId, joined, unjoined, stats, findings, missing: [...new Set([...(extra.missing ?? []), ...missing])], truncated: extra.truncated ?? false };
}

async function main(argv) {
  const started = Date.now();
  const fixtureAt = argv.indexOf("--fixture");
  const episodeId = argv.find((arg, at) => !arg.startsWith("--") && (fixtureAt < 0 || at !== fixtureAt + 1));
  if (!episodeId || !EPISODE_ID.test(episodeId)) {
    console.error("usage: pnpm diagnose:call <episode id> [--fixture rows.json] [--strict]");
    return 64;
  }
  const source = fixtureAt >= 0 ? { rows: JSON.parse(await readFile(argv[fixtureAt + 1], "utf8")).map((row) => normalizeRow(row)), missing: [] } : await readSources({ episodeId, env: process.env });
  const result = diagnoseRows(episodeId, source.rows, source);
  console.log(render({ ...result, elapsedMs: Date.now() - started }));
  const lost = result.unjoined.length;
  return argv.includes("--strict") && lost > 0 ? 2 : 0;
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
