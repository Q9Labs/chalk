#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, glob, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRun, loadConfig, save, maskCredentials, publicFailure, errorEvidence, check } from "../prod-proof/runtime.mjs";
import { prepareIntegration } from "../prod-proof/proofs.mjs";
import { cleanupRun, runLabel } from "../prod-proof/cleanup.mjs";

const runId = process.env.CHALK_PROOF_RUN_ID ?? `web-${randomUUID()}`;
runLabel(runId);
const directory = resolve(".private/prod-proof", runId);
let run;
let child;
let stopping = false;
function terminate(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
const stop = () => {
  stopping = true;
  if (child?.pid) terminate(child.pid);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const report = { result: "failed", cleanup: "not-started" };
try {
  check(process.env.CHALK_PROOF_CONFIG_SOURCE === "env", "Web proof requires environment configuration", "configuration");
  run = await createRun(await loadConfig(), directory, undefined, runId);
  await mkdir(".private", { recursive: true, mode: 0o700 });
  await writeFile(".private/web-proof-run-id", runId, { mode: 0o600 });
  await prepareIntegration(run, false);
  const space = await run.apiRequest("POST", `${run.tenantPath}/spaces`, {
    name: run.label,
    slug: `web-proof-${randomUUID()}`,
    metadata: { proof_run_id: runId },
    media_plane: "cf_sfu",
    recording_policy: "manual",
    transcription_policy: "on_demand",
    default_episode_duration_seconds: 1800,
    maximum_episode_duration_seconds: 1800,
    linger_window_seconds: 60,
    admission_policy: { mode: "open" },
  });
  await save(`${directory}/space.json`, space);
  const episode = await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: runId } });
  await save(`${directory}/episode.json`, episode);
  const invite = await run.ownerRequest("PATCH", `${run.tenantPath}/spaces/${space.id}/public-invite`, { enabled: true });
  const url = new URL(invite.canonical_url);
  const web = new URL(run.config.web_url);
  // Rebase the environment's invite onto the selected web build, never its API.
  const entry = `${url.pathname}${url.search}${url.hash}`;
  maskCredentials({ inviteToken: url.hash.slice(1), inviteCredential: entry, canonicalCredential: invite.canonical_url });
  check(!stopping, "Web proof was interrupted");
  const code = await new Promise((accept, reject) => {
    child = spawn("pnpm", ["exec", "e2e", "run"], {
      detached: true,
      stdio: "inherit",
      env: { ...process.env, E2E_TELEMETRY_DISABLED: "1", CHALK_PROOF_WEB_URL: web.origin, CHALK_E2E_INVITE: entry, CHALK_E2E_DIRECTORY: directory, CHALK_E2E_API_KEY: run.apiKey, CHALK_E2E_RUN_ID: runId },
    });
    const timer = setTimeout(stop, 300_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (status) => {
      clearTimeout(timer);
      accept(status);
    });
  });
  for await (const shot of glob(".private/web-proof/e2e/results/**/screenshots/*participant-a*.png")) {
    await copyFile(shot, `${directory}/participant-a.png`);
  }
  check(code === 0 && !stopping, "Web call e2e failed");
  report.result = "passed";
} catch (error) {
  if (run) await save(`${directory}/error.json`, errorEvidence(error));
  publicFailure("web-call", error);
} finally {
  if (run) {
    try {
      await cleanupRun(run);
      report.cleanup = "passed";
    } catch (error) {
      report.cleanup = "failed";
      await save(`${directory}/cleanup-error.json`, errorEvidence(error));
      publicFailure("web-cleanup", error);
    }
    await save(`${directory}/web-proof-report.json`, report);
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
const passed = report.result === "passed" && report.cleanup === "passed";
console.log(`WEB PROOF: ${passed ? "passed" : "failed"}; cleanup: ${report.cleanup}`);
process.exitCode = passed ? 0 : 1;
