#!/usr/bin/env node
// Two ratchets over tracked files. A number in scripts/gates/ratchets.json may only fall.
//
//   file size   no new source file over 300 lines, and a file already over 300 may not grow.
//   copies      the count of each hand-copied value and special-case shape may not rise.
//
//   ratchets.mjs           fails when a file grew, a file crossed 300 lines, or a count rose
//   ratchets.mjs --write   lowers the baseline to the current numbers; it refuses to raise any
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot } from "../lib/repository.mjs";

const baselineFile = join(repositoryRoot, "scripts/gates/ratchets.json");
const maxLines = 300;
const sourceFile = /\.(go|ex|exs|ts|tsx|mjs|cjs|js|py|sh)$/;
const generatedFile = /(^|\/)(generated|sqlc)\/|\.gen\.ts$|\.generated\.|(^|\/)routeTree\.gen\.ts$|(^|\/)pnpm-lock\.yaml$|\/node_modules\//;

const generatedExclusions = [":!scripts/gates/ratchets.*", ":!**/generated/**", ":!**/*.gen.ts", ":!**/*.generated.*", ":!pnpm-lock.yaml", ":!**/sqlc/**", ":!**/routeTree.gen.ts"];

// Each entry counts the lines that match `regex` in the files that `paths` select. Lower is better.
const copies = {
  "copy.provider_names": { regex: `"(cf_sfu|cloudflare_sfu|chalk_sfu)"|'(cf_sfu|cloudflare_sfu|chalk_sfu)'`, paths: ["*.go", "*.ex", "*.ts", "*.tsx", "*.mjs", "*.sql"] },
  "copy.port_8443": { regex: "8443", paths: [":!*.md"] },
  "copy.pnpm_version": { regex: "12\\.8\\.1", paths: [".github/**", "scripts/**", "infrastructure/**"] },
  "copy.excalidraw_pin": { regex: "0\\.18\\.1", paths: [":!*.md", ":!CHANGELOG*"] },
  "copy.mathjax_pin": { regex: "4\\.1\\.3", paths: [":!*.md", ":!CHANGELOG*"] },
  "copy.percentile_impls": { regex: "(function|const) +(percentile|nearestRank)", paths: ["*.mjs", "*.ts"] },
  "copy.entrypoint_checks": { regex: "import\\.meta\\.url *=== *.*pathToFileURL|process\\.argv\\[1\\] *===", paths: ["*.mjs", "*.ts"] },
  "copy.spiffe_parsers": { regex: "spiffe://", paths: ["*.go", ":!*_test.go"] },
  "copy.media_providers_header": { regex: "X-Chalk-Media-Providers", paths: ["*.ts", "*.tsx", "*.go"] },
  "special.kind_capture_branches": { regex: "kind *[!=]= *kindCapture", paths: ["features/media/**"] },
  "special.service_nil_checks": { regex: "== nil", paths: ["apps/api/internal/httpapi/**", ":!*_test.go"] },
  "special.authorize_tenant_calls": { regex: "authorizeTenant\\(", paths: ["apps/api/internal/httpapi/**", ":!*_test.go"] },
  "special.sleeps": { regex: "time\\.Sleep\\(|Process\\.sleep\\(|setTimeout\\(r(esolve)?, *[0-9]", paths: [":!*_test.go", ":!*.test.ts", ":!**/test/**"] },
  "special.swallowed_rescue": { regex: "rescue *_ *->|catch *\\{ *\\}|catch *\\(_\\w*\\) *\\{ *\\}", paths: ["*.ex", "*.ts", "*.tsx"] },
  "special.provider_module_checks": { regex: "module *== *ProviderBridge", paths: ["apps/sync/**"] },
};

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (error) {
    if (error.status === 1) return "";
    throw error;
  }
}

function longFiles() {
  const sizes = {};
  for (const file of git(["ls-files", "-z"]).split("\0").filter(Boolean)) {
    if (!sourceFile.test(file) || generatedFile.test(file)) continue;
    const lines = readFileSync(join(repositoryRoot, file), "utf8").split("\n").length - 1;
    if (lines > maxLines) sizes[file] = lines;
  }
  return sizes;
}

function copyCounts() {
  return Object.fromEntries(
    Object.entries(copies).map(([name, { regex, paths }]) => {
      const output = git(["grep", "-E", "-c", regex, "--", ...paths, ...generatedExclusions]);
      return [
        name,
        output
          .split("\n")
          .filter(Boolean)
          .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(":") + 1)), 0),
      ];
    }),
  );
}

/** Messages for every number that rose above the baseline. */
export function rises(baseline, current) {
  const messages = [];
  for (const [file, lines] of Object.entries(current.files)) {
    const allowed = baseline.files[file];
    if (allowed === undefined) messages.push(`${file} has ${lines} lines; new files stay at ${maxLines} lines or fewer. Split it by responsibility.`);
    else if (lines > allowed) messages.push(`${file} grew from ${allowed} to ${lines} lines. Move the new code to its own file.`);
  }
  for (const [name, count] of Object.entries(current.copies)) {
    if (count > (baseline.copies[name] ?? 0)) messages.push(`${name} rose from ${baseline.copies[name] ?? 0} to ${count}. Reuse the shared value instead of copying it.`);
  }
  return messages;
}

if (import.meta.main) {
  const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
  const current = { files: longFiles(), copies: copyCounts() };
  const failures = rises(baseline, current);
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else if (process.argv.includes("--write")) {
    writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`);
    console.log("Ratchet baseline lowered to the current numbers.");
  } else {
    const lower = Object.keys(current.files).length < Object.keys(baseline.files).length || Object.entries(current.copies).some(([name, count]) => count < baseline.copies[name]);
    console.log(`Ratchets hold.${lower ? " Some numbers fell: run `node scripts/gates/ratchets.mjs --write` to lock them in." : ""}`);
  }
}
