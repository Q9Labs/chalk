#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../..");
const baselinePath = resolve(scriptDir, "explicit-any-baseline.json");

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
  const binary = process.env.OXLINT_BIN ?? resolve(root, "node_modules/.bin/oxlint");
  const args = ["-A", "all", "-D", "typescript/no-explicit-any", "--threads", "1", "-f", "json", "--ignore-pattern", "**/generated/**", "--ignore-pattern", "**/openapi-generated/**", "--ignore-pattern", "**/routeTree.gen.ts", "."];
  const result = spawnSync(binary, args, { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) throw new Error(`Could not run Oxlint: ${result.error?.message ?? result.stderr}`);
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report.diagnostics) || !report.number_of_files) throw new Error("Oxlint did not scan any files.");
  const sourceCache = new Map();
  const findings = report.diagnostics.map((diagnostic) => {
    if (diagnostic.code !== "typescript(no-explicit-any)" || !diagnostic.labels?.[0]?.span?.line) throw new Error(`Unexpected Oxlint diagnostic: ${JSON.stringify(diagnostic)}`);
    const file = diagnostic.filename.replaceAll("\\", "/");
    if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(resolve(root, file), "utf8").split("\n"));
    const line = diagnostic.labels[0].span.line;
    const text = sourceCache.get(file)[line - 1].trim();
    return { file, line, fingerprint: createHash("sha256").update(`${file}\0${text}`).digest("hex") };
  });

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
    console.log(`Recorded ${findings.length} existing explicit-any violations across ${report.number_of_files} scanned files.`);
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { added, removed } = compareBaseline(findings, baseline);
  if (added.length) console.error("New explicit any types are not allowed:\n" + added.map(({ file, line }) => `${file}:${line}`).join("\n"));
  if (removed) console.error(`${removed} baseline any violation(s) were removed or changed. Run node scripts/gates/explicit-any.mjs --update-baseline and review the baseline diff.`);
  if (added.length || removed) process.exitCode = 1;
  else console.log(`No new explicit any types (${findings.length} existing violations remain across ${report.number_of_files} scanned files).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
