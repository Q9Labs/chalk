import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecoveryOutput, percentile, planModes, summarize, trialResult } from "./failover-batch.mjs";

const report = (down, up) => ({
  down: { audio: down === null ? { never_back: true, back_after_fault_start_s: null } : { never_back: false, back_after_fault_start_s: down } },
  up: { audio: { never_back: false, back_after_fault_start_s: up } },
});

test("parses the recovery report printed before the evidence line", () => {
  const text = `noise\n${JSON.stringify(report(3, 4))}\nPrivate evidence: /x\n`;
  assert.equal(parseRecoveryOutput(text).up.audio.back_after_fault_start_s, 4);
  assert.equal(parseRecoveryOutput("no json"), null);
});

test("a trial recovers only when both directions come back and the harness exits 0", () => {
  assert.deepEqual(trialResult({ name: "a", mode: "stop", exitCode: 0, report: report(3, 5) }).audioBackS, 5);
  assert.equal(trialResult({ name: "b", mode: "stop", exitCode: 0, report: report(null, 5) }).recovered, false);
  assert.equal(trialResult({ name: "c", mode: "stop", exitCode: 1, report: report(3, 5) }).recovered, false);
  assert.equal(trialResult({ name: "d", mode: "stop", exitCode: 0, report: null }).recovered, false);
});

test("summary passes only on all recovered, p95 under 10 s, 0 Cloudflare requests and 5 stop trials", () => {
  const trials = planModes(["stop", "blackhole"], 10).map((mode, i) => trialResult({ name: `${i}`, mode, exitCode: 0, report: report(2, 3 + i / 2) }));
  const ok = summarize({ trials, cloudflareRequests: 0, dryRun: false });
  assert.equal(ok.recoveredOfN, "10/10");
  assert.equal(ok.pass, true);
  assert.equal(summarize({ trials, cloudflareRequests: null, dryRun: false }).pass, false);
  assert.equal(summarize({ trials, cloudflareRequests: 1, dryRun: false }).pass, false);
  assert.equal(summarize({ trials, cloudflareRequests: 0, dryRun: true }).pass, false);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5.5);
});
