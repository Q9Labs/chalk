#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((file) => file && existsSync(path.join(root, file)));
const scripts = new Set(files.filter((file) => path.basename(file) === "package.json").flatMap((file) => Object.keys(JSON.parse(readFileSync(path.join(root, file), "utf8")).scripts ?? {})));
// pnpm's own subcommands are not package scripts. Everything else must be declared.
const pnpmCommands = new Set([
  "add",
  "approve-builds",
  "audit",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dlx",
  "env",
  "exec",
  "fetch",
  "help",
  "import",
  "init",
  "install",
  "link",
  "list",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "setup",
  "store",
  "unlink",
  "update",
  "view",
  "why",
]);
const examples = JSON.parse(readFileSync(path.join(root, "scripts/gates/doclint-examples.json"), "utf8"));
// Frozen evidence and release notes are history, not maintained runbooks.
const docs = files.filter((file) => /\.(md|mdx)$/.test(file) && !/^(?:scratchpad\/|docs\/proofs\/|\.changeset\/)|(?:^|\/)(?:CHANGELOG\.md|testdata\/|fixtures\/)/.test(file));
let errors = 0;
function fail(file, line, message) {
  console.error(`${file}:${line}: ${message}`);
  errors++;
}
function localExists(file, target, repoPath = true) {
  let clean;
  try {
    clean = decodeURIComponent(target.replace(/[#?].*$/, "").replace(/:\d+(?:[-,:]\d+)*$/, ""));
  } catch {
    return false;
  }
  if (!repoPath) return existsSync(path.resolve(root, path.dirname(file), clean));
  let owner = path.dirname(file);
  while (owner !== "." && !existsSync(path.join(root, owner, "package.json")) && !existsSync(path.join(root, owner, "go.mod")) && !existsSync(path.join(root, owner, "mix.exs"))) owner = path.dirname(owner);
  return [path.dirname(file), owner, "."].some((base) => existsSync(path.resolve(root, base, clean)));
}
function isRepoPath(value) {
  return (
    !/\s|[<>|=]|^[@~/#]|:\/\//.test(value) &&
    (/^(?:\.\.?\/|apps\/|packages\/|sdks\/|scripts\/|docs\/|contract\/|infrastructure\/|tools\/|\.github\/|\.semgrep\/)/.test(value) || /(?:^|\/)[\w.-]+\.(?:mdx?|[cm]?js|[jt]sx?|json|ya?ml|sh|go|exs?|css|html|toml|sql|proto|lock)(?::\d[\d,:-]*)?$/.test(value))
  );
}
for (const file of docs) {
  const lines = readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
  let fence;
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    // The one historical budget provenance sentence is intentional, not runner guidance.
    if (/testbox/i.test(line) && !(file === "docs/performance-budget.md" && line === "The budgets were measured on Testbox's 8-core box. An Instabox timing is not a budget result until the budgets are re-measured there.")) fail(file, number, "retired runner reference");
    const commands = line.replace(/--(?:dir|filter|filter-prod)\s+\S+\s+/g, "");
    for (const match of commands.matchAll(/\bpnpm\s+(?:(?:--[\w-]+(?:=\S+)?|-[rws])\s+)*(?:(run)\s+)?([a-zA-Z][\w:.-]*)/g)) {
      const [, run, command] = match;
      if (!scripts.has(command) && (run || !pnpmCommands.has(command))) fail(file, number, `unknown pnpm script: ${command}`);
    }
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const prose = line.replace(/`[^`]*`/g, "");
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)|^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/g)) {
      const target = (match[1] ?? match[2]).replace(/^<|>$/g, "");
      if (!/^(?:[a-z][\w+.-]*:|#|\/)/i.test(target) && !localExists(file, target, false)) fail(file, number, `missing Markdown target: ${target}`);
    }
    for (const match of line.matchAll(/(?<!`)`([^`]+)`(?!`)/g)) {
      const target = match[1];
      if (!isRepoPath(target) || localExists(file, target)) continue;
      if (examples.some((example) => example.file === file && example.path === target && example.reason)) continue;
      // A glob is valid only if it actually describes a tracked path.
      if (/[*{]/.test(target)) {
        const escaped = target
          .replace(/[.+^$()|[\]\\]/g, "\\$&")
          .replaceAll("**", "\0")
          .replaceAll("*", "[^/]*")
          .replaceAll("\0", ".*")
          .replaceAll("{", "(?:")
          .replaceAll("}", ")")
          .replaceAll(",", "|");
        const glob = new RegExp(`^${escaped.replace(/\/$/, "")}(?:/.*)?$`);
        if (files.some((candidate) => glob.test(candidate) || glob.test(path.relative(path.dirname(file), candidate)))) continue;
      }
      fail(file, number, `missing repo path: ${target}`);
    }
  }
}
if (errors) process.exitCode = 1;
else console.log(`doclint: ${docs.length} maintained documents passed`);
