#!/usr/bin/env node
// Two reference checks over tracked files.
//
//   script callers       every script under scripts/ and tools/ is named by a workflow, a package.json script,
//                        a skill, a doc or another script that is itself called.
//   workflow references  every repository path a workflow or action names exists, and every
//                        `pnpm run <name>` it runs is a root package.json script.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { repositoryRoot } from "../lib/repository.mjs";

const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".svg", ".wav", ".mp3", ".ogg", ".opus", ".mp4", ".webm", ".mov", ".woff2", ".gz", ".zip", ".bin"]);
const scriptExtensions = new Set([".mjs", ".cjs", ".js", ".ts", ".tsx", ".py", ".sh"]);
const stemImportExtensions = new Set([".py", ".ts", ".tsx", ".js", ".cjs"]);

const isTest = (file) => /\.test\.|\/test_|_test\.|\.spec\./.test(file);

function trackedFiles(root = repositoryRoot) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0")
    .filter(Boolean);
}

function readText(file, root) {
  if (binaryExtensions.has(extname(file)) || file.endsWith("pnpm-lock.yaml")) return undefined;
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return undefined;
  }
}

/** Scripts that nothing calls, found by following the references from every other file until the set stops growing. */
export function uncalledScripts(root = repositoryRoot, files = trackedFiles(root)) {
  const scripts = files.filter((file) => /^(scripts|tools)\//.test(file) && scriptExtensions.has(extname(file)) && !/\.d\.[mc]?ts$/.test(file) && !isTest(file));
  const scriptSet = new Set(scripts);
  const referrers = new Map(scripts.map((file) => [file, new Set()]));
  const byBasename = new Map();
  const byStem = new Map();
  for (const file of scripts) {
    const name = basename(file);
    const stem = name.slice(0, name.length - extname(name).length);
    byBasename.set(name, [...(byBasename.get(name) ?? []), file]);
    byStem.set(stem, [...(byStem.get(stem) ?? []), file]);
  }
  for (const file of files) {
    const text = readText(file, root);
    if (text === undefined) continue;
    const extension = extname(file);
    for (const token of text.match(/[A-Za-z0-9_./@-]+/g) ?? []) {
      const name = token.slice(token.lastIndexOf("/") + 1);
      for (const target of byBasename.get(name) ?? []) {
        if (token === name || token.endsWith(`/${name}`)) referrers.get(target).add(file);
      }
    }
    if (stemImportExtensions.has(extension)) {
      const imported = extension === ".py" ? text.match(/[A-Za-z0-9_]+/g) : [...text.matchAll(/["']\.{1,2}\/(?:[^"']*\/)?([^"'/]+)["']/g)].map((match) => match[1]);
      for (const word of new Set(imported ?? [])) {
        for (const target of byStem.get(word) ?? []) referrers.get(target).add(file);
      }
    }
  }
  const ownTest = (script, file) => isTest(file) && dirname(file) === dirname(script) && basename(file).includes(basename(script, extname(script)));
  const dead = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const script of scripts) {
      if (dead.has(script)) continue;
      const live = [...referrers.get(script)].some((file) => file !== script && !dead.has(file) && !ownTest(script, file));
      if (!live) {
        dead.add(script);
        changed = true;
      }
    }
  }
  return scripts.filter((script) => dead.has(script) && scriptSet.has(script));
}

const pathPattern = /(?<![A-Za-z0-9_./-])(?:\.\/)?((?:scripts|tools|infrastructure|features|apps|sdks|packages|perf|release|contract|docs|tests|\.github)\/[A-Za-z0-9_./@-]*[A-Za-z0-9_@-])(?![A-Za-z0-9_./@$*{-])/g;

function isIgnored(path, root) {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { cwd: root });
    return true;
  } catch {
    // A pattern such as /apps/sync/deps/ matches a folder that does not exist only when written with its trailing slash.
    try {
      execFileSync("git", ["check-ignore", "-q", `${path}/`], { cwd: root });
      return true;
    } catch {
      return false;
    }
  }
}

/** Repository paths and root package scripts that workflows and actions name but that do not exist. */
export function brokenWorkflowReferences(root = repositoryRoot, files = trackedFiles(root)) {
  const rootScripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts));
  const problems = [];
  for (const file of files.filter((candidate) => /^\.github\/(workflows\/[^/]+\.ya?ml|actions\/[^/]+\/action\.ya?ml)$/.test(candidate))) {
    const text = readText(file, root) ?? "";
    text.split("\n").forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      for (const [, path] of line.matchAll(pathPattern)) {
        if (!existsSync(join(root, path)) && !isIgnored(path, root)) problems.push(`${file}:${index + 1}: ${path} does not exist`);
      }
      for (const [, name] of line.matchAll(/(?<!--filter\s\S+\s)\bpnpm run ([A-Za-z0-9:_-]+)/g)) {
        if (!line.includes("--filter") && !rootScripts.has(name)) problems.push(`${file}:${index + 1}: pnpm run ${name} is not a root package.json script`);
      }
    });
  }
  return problems;
}

if (import.meta.main) {
  const failures = [...uncalledScripts().map((script) => `${script}: nothing calls this script; call it or delete it`), ...brokenWorkflowReferences()];
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("References are valid: every script has a caller and every workflow path exists.");
}
