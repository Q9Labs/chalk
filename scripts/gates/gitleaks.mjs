#!/usr/bin/env node
// Secret scan: staged changes, explicit files, and the commits of this branch, with the gitleaks binary or `go run`.
// Environment: GATE_SCOPE (staged | full), GATE_EXPLICIT_FILES (newline-separated paths), GITLEAKS_BASE_REF (default
// origin/master), GITLEAKS_LOG_OPTS (replaces the commit range).
import { lstatSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { findExecutable, runCommand, spawnCommandSync } from "../lib/platform.mjs";
import { toolVersion } from "../lib/tool-version.mjs";

const configPath = ".gitleaks.toml";
const baseRef = process.env.GITLEAKS_BASE_REF || "origin/master";

/** @param {string[]} args */
function git(args) {
  const result = spawnCommandSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { ok: result.status === 0, output: String(result.stdout ?? "").trim() };
}

function commitRange() {
  const configured = process.env.GITLEAKS_LOG_OPTS ?? "";
  if (configured || !git(["rev-parse", "--is-inside-work-tree"]).ok) return configured;
  if (git(["rev-parse", "--verify", "--quiet", baseRef]).ok) {
    const mergeBase = git(["merge-base", baseRef, "HEAD"]);
    if (mergeBase.ok && mergeBase.output && git(["rev-list", "--count", `${mergeBase.output}..HEAD`]).output !== "0") return `${mergeBase.output}..HEAD`;
  }
  return "-1 HEAD";
}

/** Returns the first failing exit status, or 0 when every scan passed. */
function scan(/** @type {string} */ command, /** @type {string[]} */ prefix) {
  const run = (/** @type {string[]} */ args) => runCommand(command, [...prefix, ...args]);
  const scope = process.env.GATE_SCOPE;

  const root = realpathSync(process.cwd());
  for (const file of (process.env.GATE_EXPLICIT_FILES ?? "").split(/\r?\n/)) {
    if (!file || !existsSync(file)) continue;
    // lstat does not follow links, so a symlink is never a regular file here.
    if (!lstatSync(file).isFile() || !realpathSync(path.resolve(file)).startsWith(root + path.sep)) {
      console.error(`Explicit gate file is not a regular in-repository file: ${file}`);
      return 1;
    }
    // Pass the path as Git names it, because allowlist paths are anchored at the repository root.
    const status = run(["dir", "--config", configPath, "--redact", "--verbose", "--", file.replace(/^\.\//, "")]);
    if (status !== 0) return status;
  }

  if (scope === "staged" || scope === "full") {
    const status = run(["protect", "--staged", "--config", configPath, "--redact", "--verbose"]);
    // A full run also scans commits, because a clean CI checkout has nothing staged.
    if (status !== 0 || scope !== "full") return status;
  }

  const range = commitRange();
  return range ? run(["git", ".", "--log-opts", range, "--config", configPath, "--redact", "--verbose"]) : run(["git", ".", "--config", configPath, "--redact", "--verbose", "--timeout", "120"]);
}

if (findExecutable("gitleaks")) process.exit(scan("gitleaks", []));
if (findExecutable("go")) process.exit(scan("go", ["run", `github.com/zricethezav/gitleaks/v8@v${toolVersion("gitleaks")}`]));
console.error("Gitleaks is required. Install gitleaks or Go, then rerun pnpm run security:secrets.");
process.exit(127);
