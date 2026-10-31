#!/usr/bin/env node
// Compare the restored production baseline and staging in one alternating session.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { cleanupRun } from "./cleanup.mjs";
import { evaluateLeaves } from "./leave-criteria.mjs";
import { baselineEntry, sampleLeave } from "./leave.mjs";
import { prepareIntegration } from "./proofs.mjs";
import { check, createRun, environmentConfig, errorEvidence, loadConfig, publicFailure, save } from "./runtime.mjs";

const baselineSha = "2ec22c54b46ba4b215637cd98fdcd3bd6275cb16";
async function verifyBaseline() {
  const response = await fetch(`https://chalkmeet.com/release.json?leave_comparison=${randomUUID()}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  check(response.ok && (await response.json()).commit === baselineSha, "Production is not the requested 5.2.6 baseline");
}

async function compare(candidateRun, referenceRun) {
  await verifyBaseline();
  const receiver = await prepareIntegration(candidateRun, false);
  const referenceReceiver = await prepareIntegration(referenceRun, false);
  const entry = await baselineEntry(referenceRun);
  const fault = await sampleLeave(referenceRun, referenceReceiver.origin, entry, "publications-403");
  await save(`${referenceRun.directory}/baseline-403.json`, fault);
  check(fault.rejectedWhileLeaving && fault.peerClosedBeforeAck, "Production baseline did not reproduce the 403 premature peer close");
  const baseline = [];
  const candidate = [];
  for (let index = 0; index < 5; index++) {
    baseline.push(await sampleLeave(referenceRun, referenceReceiver.origin, entry, "ordinary"));
    candidate.push(await sampleLeave(candidateRun, receiver.origin, undefined, "ordinary"));
    candidate.push(await sampleLeave(candidateRun, receiver.origin, undefined, "publications-403"));
    await save(`${candidateRun.directory}/session-samples.json`, { baseline, candidate });
  }
  await verifyBaseline();
  const result = { ...evaluateLeaves(baseline, candidate), baselineSha, baselineSdk: "5.2.6", baselineBackend: "production", candidateBackend: "nightly", measuredAt: new Date().toISOString() };
  await save(`${candidateRun.directory}/session-comparison.json`, result);
  check(result.passed, "Production baseline versus staging Leave comparison failed");
  return result;
}

const session = randomUUID();
const report = { result: "failed", cleanup: "not-started" };
const runs = [];
try {
  const candidateRun = await createRun(await loadConfig(), resolve(".private/prod-proof", `candidate-${session}`), undefined, `candidate-${session}`);
  runs.push(candidateRun);
  const config = environmentConfig(JSON.parse(process.env.CHALK_PROOF_BASELINE_ENV));
  const referenceRun = await createRun(config, resolve(".private/prod-proof", `baseline-${session}`), undefined, `baseline-${session}`);
  runs.push(referenceRun);
  report.comparison = await compare(candidateRun, referenceRun);
  report.result = "passed";
} catch (error) {
  report.error = errorEvidence(error);
  publicFailure("leave-session", error);
} finally {
  const cleanup = await Promise.allSettled(runs.map((run) => cleanupRun(run)));
  report.cleanup = cleanup.every((result) => result.status === "fulfilled") ? "passed" : "failed";
  if (runs[0]) await save(`${runs[0].directory}/session-report.json`, report);
  console.log(JSON.stringify({ result: report.result, cleanup: report.cleanup, comparison: report.comparison }));
  if (report.result !== "passed" || report.cleanup !== "passed") process.exitCode = 1;
}
