import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRun, errorEvidence, loadConfig, publicFailure } from "./runtime.mjs";
import { cleanupRun, runLabel, sweepStaleRuns } from "./cleanup.mjs";
import { prepareIntegration } from "./proofs.mjs";

/**
 * The frame of a standalone proof tool: a run id (CHALK_PROOF_RUN_ID or a fresh one), a private evidence directory, a configured run
 * with its integration receiver, and cleanup however `execute(run, receiver)` ends. A failure lands in report.error and a cleanup
 * failure in report.cleanupError. `validate` checks the flags before anything is created. The caller writes the report into the returned directory.
 */
export async function runStandalone(tool, report, execute, { validate, readiness } = {}) {
  const runId = process.env.CHALK_PROOF_RUN_ID ?? `${Date.now()}-${randomUUID()}`;
  runLabel(runId);
  const directory = resolve(".private", "prod-proof", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let run;
  try {
    validate?.();
    const config = await loadConfig({ readiness });
    await sweepStaleRuns(config);
    run = await createRun(config, directory, undefined, runId);
    await execute(run, await prepareIntegration(run, false));
  } catch (error) {
    report.error = errorEvidence(error);
    publicFailure(tool, error);
  } finally {
    if (run) await cleanupRun(run).catch((error) => (report.cleanupError = errorEvidence(error)));
  }
  return { runId, directory };
}
