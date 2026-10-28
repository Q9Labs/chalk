#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../..");
const baselinePath = resolve(scriptDir, "explicit-any-baseline.json");
const require = createRequire(import.meta.url);
const ts = require("typescript");

export function findExplicitAny(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines = source.split("\n");
  const findings = [];
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      const text = lines[line - 1].trim();
      findings.push({ file, line, fingerprint: createHash("sha256").update(`${file}\0${text}`).digest("hex") });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return findings;
}

export function compareBaseline(findings, baseline) {
  const remaining = Object.fromEntries(baseline.map(({ fingerprint, count }) => [fingerprint, count]));
  const added = [];
  for (const finding of findings) {
    if (remaining[finding.fingerprint] > 0) remaining[finding.fingerprint]--;
    else added.push(finding);
  }
  return { added, removed: Object.values(remaining).reduce((sum, count) => sum + count, 0) };
}

function run() {
  // Read syntax, not lint diagnostics: disable comments and lint config cannot hide a type ban.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => /\.(?:[cm]?ts|tsx)$/u.test(file) && !/(?:^|\/)(?:generated|openapi-generated)\//u.test(file) && !/(?:^|\/)routeTree\.gen\.ts$/u.test(file));
  if (!files.length) throw new Error("No TypeScript source files were found.");
  const findings = files.flatMap((file) => findExplicitAny(file, readFileSync(resolve(root, file), "utf8")));

  if (process.argv.includes("--update-baseline")) {
    const entries = new Map();
    for (const { file, fingerprint } of findings) {
      const existing = entries.get(fingerprint);
      if (existing) existing.count++;
      else entries.set(fingerprint, { file, fingerprint, count: 1 });
    }
    writeFileSync(
      baselinePath,
      `${JSON.stringify(
        [...entries.values()].sort((a, b) => a.file.localeCompare(b.file) || a.fingerprint.localeCompare(b.fingerprint)),
        null,
        2,
      )}\n`,
    );
    console.log(`Recorded ${findings.length} existing explicit-any violations across ${files.length} scanned files.`);
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { added, removed } = compareBaseline(findings, baseline);
  if (added.length) console.error("New explicit any types are not allowed:\n" + added.map(({ file, line }) => `${file}:${line}`).join("\n"));
  if (removed) console.error(`${removed} baseline any violation(s) were removed or changed. Run node scripts/gates/explicit-any.mjs --update-baseline and review the baseline diff.`);
  if (added.length || removed) process.exitCode = 1;
  else console.log(`No new explicit any types (${findings.length} existing violations remain across ${files.length} scanned files).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
