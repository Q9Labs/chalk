#!/usr/bin/env node
// UI check: walks the call-state journeys on this branch and on a base ref, then reports what the branch broke.
//
//   node scripts/ui-check/run.mjs [--base origin/master] [--out DIR] [--only journey-prefix[,...]]
//
// Needs `pnpm install` and Playwright's Chromium. It checks the base ref out in a temporary worktree and installs it.
// Exits 1 when the branch adds a layout finding or the vision review points at a break in a changed region.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serveBuild } from "../../apps/web/scripts/call-performance-server.mjs";
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
// Master's frames depend only on master and on the check code, so a run can keep them in this directory and reuse them.
const baseCache = option("base-cache") ? resolve(option("base-cache")) : undefined;
const started = Date.now();
const run = promisify(execFile);

// Written into apps/web of the tree it builds, because that tree may be an older base, and its import must resolve next to that tree's own harness config.
const BUILD_CONFIG = `import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import callStates from "./vite.call-states.config";

export default mergeConfig(callStates, {
  build: {
    outDir: process.env.UI_CHECK_BUILD_DIR,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "call-states": fileURLToPath(new URL("./call-states.html", import.meta.url)),
        "pre-join-states": fileURLToPath(new URL("./pre-join-states.html", import.meta.url)),
      },
    },
  },
});
`;

/** Builds the harness of the tree at `root` and serves the build; the build is static, so it loads fast and the same every time. */
async function startHarness(root) {
  const dir = mkdtempSync(join(tmpdir(), "ui-check-build-"));
  const web = join(root, "apps/web");
  const config = join(web, "vite.ui-check-build.config.ts");
  writeFileSync(config, BUILD_CONFIG);
  try {
    await run("pnpm", ["exec", "vite", "build", "--config", config], { cwd: web, env: { ...process.env, UI_CHECK_BUILD_DIR: dir } });
  } finally {
    rmSync(config, { force: true });
  }
  const server = await serveBuild(dir);
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** What decides master's frames: its commit, the check code that walked it, and the journeys chosen. */
function baseKey() {
  const sha = execFileSync("git", ["rev-parse", baseRef], { cwd: repository, encoding: "utf8" }).trim();
  const code = createHash("sha256");
  for (const file of ["capture.mjs", "journeys.mjs", "page-checks.mjs"]) code.update(readFileSync(join(import.meta.dirname, file)));
  return `${sha}-${code.digest("hex").slice(0, 12)}-${only?.join(",") ?? "all"}`;
}

const dirs = { head: join(out, "head"), base: baseCache ?? join(out, "base"), diff: join(out, "diff") };
const key = baseKey();
const cacheHit = baseCache !== undefined && existsSync(join(dirs.base, "key.txt")) && readFileSync(join(dirs.base, "key.txt"), "utf8") === key;
const baseRoot = cacheHit ? undefined : mkdtempSync(join(tmpdir(), "ui-check-base-"));
const harnesses = [];
try {
  await mkdir(out, { recursive: true });
  if (baseRoot) {
    if (baseCache && existsSync(dirs.base)) for (const name of readdirSync(dirs.base)) rmSync(join(dirs.base, name), { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "--detach", "--force", baseRoot, baseRef], { cwd: repository, stdio: "inherit" });
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: baseRoot, stdio: "ignore" });
  }
  const [head, base] = await Promise.all([startHarness(repository), baseRoot ? startHarness(baseRoot) : undefined]);
  harnesses.push(head, ...(base ? [base] : []));

  // With master's frames cached, the machine is free for the branch alone.
  const concurrency = base ? 3 : 5;
  const headWalk = capture({ origin: head.origin, out: dirs.head, only, concurrency });
  const baseWalk = base ? capture({ origin: base.origin, out: dirs.base, only, concurrency }) : Promise.resolve({ frames: JSON.parse(readFileSync(join(dirs.base, "frames.json"), "utf8")) });
  const [headRun, baseRun] = await Promise.all([headWalk, baseWalk]);
  if (base && baseCache) writeFileSync(join(dirs.base, "key.txt"), key);
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
    baseFrames: cacheHit ? "cached" : "walked",
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
  if (baseRoot) {
    execFileSync("git", ["worktree", "remove", "--force", baseRoot], { cwd: repository, stdio: "ignore" });
    rmSync(baseRoot, { recursive: true, force: true });
  }
}
