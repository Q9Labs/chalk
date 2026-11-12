#!/usr/bin/env node
// Checks that every pinned tool version comes from its one source: GitHub Action SHAs from .github/action-pins.json,
// tool releases from .tool-versions. `--write` rewrites the action references to the pinned SHAs.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { repositoryRoot } from "../lib/repository.mjs";

const pins = JSON.parse(readFileSync(join(repositoryRoot, ".github/action-pins.json"), "utf8"));
const toolVersions = Object.fromEntries(
  readFileSync(join(repositoryRoot, ".tool-versions"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.trim().split(/\s+/)),
);

const actionFiles = [...readdirSync(join(repositoryRoot, ".github/workflows")).map((name) => `.github/workflows/${name}`), ...readdirSync(join(repositoryRoot, ".github/actions")).map((name) => `.github/actions/${name}/action.yml`)];
const usesLine = /^(\s*(?:- )?uses: )([\w.-]+\/[\w.-]+)((?:\/[\w./-]+)?)@(\S+)(?: # .*)?$/;

export function actionPinProblems(write) {
  const problems = [];
  for (const file of actionFiles) {
    const lines = readFileSync(join(repositoryRoot, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const match = usesLine.exec(line);
      if (!match) return;
      const [, prefix, repository, path] = match;
      const pin = pins[repository];
      if (!pin) {
        problems.push(`${file}:${index + 1} uses ${repository}, which has no entry in .github/action-pins.json`);
        return;
      }
      const wanted = `${prefix}${repository}${path}@${pin.sha} # ${pin.tag}`;
      if (line === wanted) return;
      if (write) lines[index] = wanted;
      else problems.push(`${file}:${index + 1} should read: ${wanted.trim()}`);
    });
    if (write) writeFileSync(join(repositoryRoot, file), lines.join("\n"));
  }
  return problems;
}

export function openTofuPinProblems() {
  const wanted = toolVersions.opentofu;
  const files = execFileSync("git", ["ls-files", "*.tf"], { cwd: repositoryRoot, encoding: "utf8" }).split("\n").filter(Boolean);
  const problems = [];
  for (const file of files) {
    const match = /required_version\s*=\s*"= ?([\d.]+)"/.exec(readFileSync(join(repositoryRoot, file), "utf8"));
    if (match && match[1] !== wanted) problems.push(`${file} requires OpenTofu ${match[1]}, .tool-versions pins ${wanted}`);
  }
  return problems;
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const problems = [...actionPinProblems(write), ...openTofuPinProblems()];
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error("Run `node scripts/gates/pins.mjs --write` to repoint the action references.");
    process.exitCode = 1;
  }
}
