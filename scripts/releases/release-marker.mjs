#!/usr/bin/env node
// Posts one release.marker row to the infra dataset so diagnose can place a
// deploy, rollback, automatic rollback or failed attempt on the platform
// timeline. The caller knows the deployment's result; this script only carries
// it. Posting always fails open: a marker that cannot be delivered is reported
// on the GitHub step summary or stderr and the exit status stays zero, because
// a lost marker must never fail a deploy.
//
//   node scripts/releases/release-marker.mjs \
//     --component api --release-id managed-episode-2026-01-01-a \
//     --commit 0123abcd... --kind deploy --environment production \
//     [--run-id 12345.1] [--started-ms 1700000000000] [--finished-ms 1700000000123]
//
// Required environment: CHALK_AXIOM_INGEST_TOKEN, CHALK_INFRA_DATASET.
import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const KINDS = new Set(["deploy", "rollback", "auto_rollback", "failed"]);
const SCHEMA_VER = "66bca601fc49";

function args(argv) {
  const parsed = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (argv[i].startsWith("--")) parsed[argv[i].slice(2)] = argv[i + 1];
  }
  return parsed;
}

function failOpen(problem) {
  const line = `release.marker not posted: ${problem}\n`;
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFile(summary, line).catch(() => process.stderr.write(line));
    return;
  }
  process.stderr.write(line);
}

export function markerRow(input, now = Date.now()) {
  return {
    event_id: randomUUID(),
    kind: "fact",
    name: "release.marker",
    module: "checker",
    env: input.environment,
    source_id: `release-marker:${input.runId ?? process.env.GITHUB_RUN_ID ?? "manual"}`,
    seq: 1,
    schema_ver: SCHEMA_VER,
    est_server_ms: now,
    component: input.component,
    release_id: input.releaseId,
    commit: input.commit,
    marker_kind: input.kind,
    started_ms: input.startedMs ?? now,
    finished_ms: input.finishedMs ?? now,
    ...(input.runId !== undefined ? { run_id: input.runId } : {}),
  };
}

export async function postMarker(row, { token = process.env.CHALK_AXIOM_INGEST_TOKEN, dataset = process.env.CHALK_INFRA_DATASET, fetchImpl = fetch } = {}) {
  if (!token || !dataset) throw new Error("CHALK_AXIOM_INGEST_TOKEN and CHALK_INFRA_DATASET are required");
  const response = await fetchImpl(`https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify([row]),
  });
  if (!response.ok) throw new Error(`Axiom ingest answered ${response.status}`);
}

export async function main(argv = process.argv, env = process.env) {
  const input = args(argv);
  const missing = ["component", "release-id", "commit", "kind", "environment"].filter((key) => !input[key]);
  if (missing.length) {
    failOpen(`missing --${missing.join(" --")}`);
    return 0;
  }
  if (!KINDS.has(input.kind)) {
    failOpen(`--kind ${input.kind} is not deploy, rollback, auto_rollback or failed`);
    return 0;
  }
  const row = markerRow({
    component: input.component,
    releaseId: input["release-id"],
    commit: input.commit,
    kind: input.kind,
    environment: input.environment,
    runId: input["run-id"],
    startedMs: input["started-ms"] === undefined ? undefined : Number(input["started-ms"]),
    finishedMs: input["finished-ms"] === undefined ? undefined : Number(input["finished-ms"]),
  });
  try {
    await postMarker(row, { token: env.CHALK_AXIOM_INGEST_TOKEN, dataset: env.CHALK_INFRA_DATASET });
  } catch (error) {
    failOpen(error.message);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
