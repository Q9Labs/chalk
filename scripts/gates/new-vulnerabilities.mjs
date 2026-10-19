#!/usr/bin/env node
// Usage: new-vulnerabilities.mjs <osv|govulncheck> <head.json> [<base.json>]
// Without a base report, exits 1 when the head report has any finding.
// With a base report, exits 1 only when the head has a finding that the base lacks, so a pull request
// fails for the package versions it changes and not for new advisories against packages it left alone.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Each finding is keyed by advisory and exact package version.
export function osvFindings(report) {
  const findings = new Set();
  for (const result of report.results ?? []) {
    for (const entry of result.packages ?? []) {
      const { ecosystem, name, version } = entry.package;
      for (const vulnerability of entry.vulnerabilities ?? []) findings.add(`${vulnerability.id} ${ecosystem} ${name}@${version}`);
    }
  }
  return findings;
}

// govulncheck writes a stream of JSON objects. Like its text mode, count only findings in called functions.
export function govulncheckFindings(stream) {
  const findings = new Set();
  for (const chunk of stream.split(/\n(?=\{)/u)) {
    if (chunk.trim() === "") continue;
    const finding = JSON.parse(chunk).finding;
    const frame = finding?.trace?.[0];
    if (frame?.function) findings.add(`${finding.osv} ${frame.module}@${frame.version}`);
  }
  return findings;
}

const readers = {
  osv: (file) => osvFindings(JSON.parse(readFileSync(file, "utf8"))),
  govulncheck: (file) => govulncheckFindings(readFileSync(file, "utf8")),
};

export function newFindings(head, base) {
  return [...head].filter((finding) => !base.has(finding)).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [format, headFile, baseFile] = process.argv.slice(2);
  const read = readers[format];
  if (!read || !headFile) {
    console.error("Usage: new-vulnerabilities.mjs <osv|govulncheck> <head.json> [<base.json>]");
    process.exit(2);
  }
  const head = read(headFile);
  const found = baseFile === undefined ? [...head].sort() : newFindings(head, read(baseFile));
  const known = head.size - found.length;
  if (known > 0) console.log(`${known} finding(s) also exist on the base branch. Master pushes and the nightly run report them.`);
  for (const finding of found) console.log(`${baseFile === undefined ? "Finding" : "New finding"}: ${finding}`);
  process.exit(found.length > 0 ? 1 : 0);
}
