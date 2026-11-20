#!/usr/bin/env node
// The commit gate: install check, doc lint, tracker check, then q9gate.
//
//   node scripts/gates/commit.mjs [--local] [--fast] [--] [q9gate run arguments...]
//
// --fast is the pre-commit profile: it selects quick lanes from the staged diff.
// Everything else, including the generated-files check, runs in the Gate workflow on the pull request, or via pnpm run gate.
// --local runs one worker at a time so the gate fits a small machine; a variable that is already set wins.
import path from "node:path";
import { repositoryRoot } from "../lib/repository.mjs";
import { runCommand } from "../lib/platform.mjs";

const args = process.argv.slice(2);
const local = args[0] === "--local";
if (local) args.shift();

const childEnvironment = { ...process.env };
// Git worktrees break Go VCS stamping (exit 128); no gate lane needs stamped binaries.
childEnvironment.GOFLAGS ||= "-buildvcs=false";
if (local) {
  childEnvironment.GOMAXPROCS ||= "1";
  childEnvironment.VITEST_MAX_WORKERS ||= "1";
  childEnvironment.ERL_FLAGS ||= "+S 1:1";
}
// q9gate and the other workspace tools live in node_modules/.bin, which pnpm adds to PATH only inside `pnpm run`.
const pathKey = Object.keys(childEnvironment).find((key) => key.toLowerCase() === "path") ?? "PATH";
childEnvironment[pathKey] = `${path.join(repositoryRoot, "node_modules", ".bin")}${path.delimiter}${childEnvironment[pathKey] ?? ""}`;
const options = { cwd: repositoryRoot, env: childEnvironment };

for (const script of ["check-install.mjs", "doclint.mjs"]) {
  const status = runCommand(process.execPath, [path.join(repositoryRoot, "scripts/gates", script)], options);
  if (status !== 0) process.exit(status);
}

if (args[0] === "--") args.shift();

const lanes = args[0] === "--fast" ? ["--lane", "scope", "--lane", "format", "--lane", "hygiene", "--lane", "secrets", "--lane", "oxlint"] : [];
if (lanes.length > 0) args.shift();

// check:tracker stays a root package script, so hygiene.mjs can verify that every script this file runs exists.
const tracker = runCommand("pnpm", ["run", "check:tracker"], options);
if (tracker !== 0) process.exit(tracker);
process.exit(runCommand("q9gate", ["run", ...lanes, ...args], options));
