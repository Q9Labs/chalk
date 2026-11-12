#!/usr/bin/env node
// UI check: walks the call-state journeys on this branch and on a base ref, then reports what the branch broke.
//
//   node scripts/ui-check/run.mjs [--base origin/master] [--out DIR] [--only journey-prefix[,...]]
//
// Needs `pnpm install` and Playwright's Chromium. It checks the base ref out in a temporary worktree and installs it.
// Exits 1 when the branch adds a layout finding or the vision review points at a break in a changed region.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { capture, planRuns } from "./capture.mjs";
import { compareFrames } from "./compare.mjs";
import { renderComment } from "./comment.mjs";
import { reviewScreens } from "./review.mjs";
import { newFindings } from "./verdict.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const repository = resolve(import.meta.dirname, "../..");
const baseRef = option("base", "origin/master");
const out = resolve(option("out", join(repository, "ui-check-report")));
const only = option("only")?.split(",").filter(Boolean);
const started = Date.now();

function startHarness(root, port) {
  const server = spawn("pnpm", ["exec", "vite", "--config", "vite.call-states.config.ts", "--port", String(port), "--strictPort"], {
    cwd: join(root, "apps/web"),
    stdio: "ignore",
    detached: true,
    env: { ...process.env, CHALK_CALL_HARNESS_CACHE_DIR: mkdtempSync(join(tmpdir(), "ui-check-vite-")) },
  });
  return { origin: `http://127.0.0.1:${port}`, stop: () => process.kill(-server.pid, "SIGTERM") };
}

async function waitFor(origin) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/call-states.html`)).ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`${origin} did not start`);
}

const baseRoot = mkdtempSync(join(tmpdir(), "ui-check-base-"));
const harnesses = [];
try {
  execFileSync("git", ["worktree", "add", "--detach", "--force", baseRoot, baseRef], { cwd: repository, stdio: "inherit" });
  execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: baseRoot, stdio: "ignore" });
  const head = startHarness(repository, 3181);
  const base = startHarness(baseRoot, 3182);
  harnesses.push(head, base);
  await Promise.all([waitFor(head.origin), waitFor(base.origin)]);
  // The first page load compiles the app, so load it once before the timed walk.
  await Promise.all([fetch(`${head.origin}/src/call-states/main.tsx`), fetch(`${base.origin}/src/call-states/main.tsx`)]);

  const dirs = { head: join(out, "head"), base: join(out, "base"), diff: join(out, "diff") };
  await mkdir(out, { recursive: true });
  const [headRun, baseRun] = await Promise.all([capture({ origin: head.origin, out: dirs.head, only }), capture({ origin: base.origin, out: dirs.base, only })]);
  const findings = newFindings(headRun.frames, baseRun.frames);
  const comparisons = await compareFrames({ headDir: dirs.head, baseDir: dirs.base, out: dirs.diff, headFrames: headRun.frames, baseFrames: baseRun.frames });
  const frameInfo = new Map(headRun.frames.map((frame) => [frame.frame, frame]));
  const review = await reviewScreens({
    comparisons: comparisons.map((item) => ({ ...item, label: frameInfo.get(item.frame)?.label ?? "", size: frameInfo.get(item.frame)?.size ?? "", scheme: frameInfo.get(item.frame)?.scheme ?? "" })),
    dir: dirs.diff,
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const blocking = findings.length > 0 || review.findings.some((finding) => finding.blocking);
  const report = {
    baseRef,
    seconds: Math.round((Date.now() - started) / 1000),
    runs: planRuns(only).length,
    frames: headRun.frames.length,
    changedFrames: comparisons.filter((item) => item.changed > 0).length,
    findings,
    review,
    comparisons,
    blocking,
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
  writeFileSync(join(out, "comment.md"), renderComment({ report, imageBase: process.env.UI_CHECK_IMAGE_BASE, frames: headRun.frames }));
  console.log(`ui-check: ${report.frames} frames in ${report.seconds}s, ${report.changedFrames} changed, ${findings.length} new layout findings, vision ${review.status} (${review.findings.length} findings, $${review.cost.toFixed(3)}). ${blocking ? "BLOCKING" : "ok"}`);
  process.exitCode = blocking ? 1 : 0;
} finally {
  for (const harness of harnesses) harness.stop();
  execFileSync("git", ["worktree", "remove", "--force", baseRoot], { cwd: repository, stdio: "ignore" });
  rmSync(baseRoot, { recursive: true, force: true });
}
