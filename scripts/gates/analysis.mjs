#!/usr/bin/env node
// Three analysis ratchets. The baseline in scripts/gates/analysis-baseline.json may only shrink.
//
//   complexity    no function above cyclomatic 15 that the baseline does not name, and a named one may not get worse
//                 (Go through gocyclo, TypeScript and JavaScript through oxlint)
//   dead-code     no unreachable Go function that the baseline does not name (deadcode, per Go module)
//   duplication   the jscpd clone count may not rise
//
//   analysis.mjs <complexity|dead-code|duplication>            fails when the baseline is exceeded
//   analysis.mjs <complexity|dead-code|duplication> --write    lowers the baseline to the current numbers; it refuses to raise any,
//                                                              and it starts a check that has no baseline yet
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { repositoryRoot } from "../lib/repository.mjs";

const baselineFile = join(repositoryRoot, "scripts/gates/analysis-baseline.json");
const maxComplexity = 15;
const goModules = ["apps/api", "features/media/sfu"];
const gocyclo = "github.com/fzipp/gocyclo/cmd/gocyclo@v0.6.0";
const deadcode = "golang.org/x/tools/cmd/deadcode@v0.52.0";
const jscpd = "jscpd@5.4.3";
const jscpdIgnore = [
  "**/generated/**",
  "**/sqlc/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/pnpm-lock.yaml",
  "**/*.lock",
  "**/*.test.*",
  "**/*_test.go",
  "**/test/**",
  "**/tests/**",
  "**/testdata/**",
  "**/fixtures/**",
  "tools/formal/media-control/results/**",
  "**/*.md",
  "**/*.json",
  "**/*.sql",
  "**/*.yml",
  "**/*.yaml",
];

function run(command, args, { cwd = repositoryRoot, okStatuses = [0] } = {}) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (okStatuses.includes(error.status)) return error.stdout;
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}: ${error.stderr ?? error.message}`);
  }
}

/** Functions above the limit: { "path function": complexity } for Go, and { "path": [complexity, ...] } for TypeScript, whose functions have no stable name. */
function measureComplexity() {
  const found = {};
  for (const module of goModules) {
    for (const line of run("go", ["run", gocyclo, "-over", String(maxComplexity), "-ignore", "_test\\.go$", "."], { cwd: join(repositoryRoot, module), okStatuses: [0, 1] }).split("\n")) {
      const match = /^(\d+) \S+ (.+?) (\S+?):\d+:\d+$/.exec(line);
      if (match) found[`${module}/${match[3].replace(/^\.\//, "")} ${match[2]}`] = Number(match[1]);
    }
  }
  const report = JSON.parse(run("pnpm", ["exec", "oxlint", "-A", "all", "-D", "complexity", "--format", "json", "."], { okStatuses: [0, 1] }));
  for (const diagnostic of report.diagnostics ?? []) {
    const complexity = Number(/complexity of (\d+)/i.exec(diagnostic.message)?.[1]);
    if (complexity > maxComplexity) found[diagnostic.filename] = [...(found[diagnostic.filename] ?? []), complexity].sort((a, b) => b - a);
  }
  return found;
}

/** Unreachable Go functions, as { "module/path function": true }. */
function measureDeadCode() {
  const found = {};
  for (const module of goModules) {
    let report;
    try {
      report = run("go", ["run", deadcode, "-test", "./..."], { cwd: join(repositoryRoot, module) });
    } catch (error) {
      if (error.message.includes("no main packages")) continue;
      throw error;
    }
    for (const line of report.split("\n")) {
      const match = /^\s*(\S+\.go):\d+:\d+: unreachable func: (\S+)/.exec(line);
      if (match) found[`${module}/${match[1]} ${match[2]}`] = true;
    }
  }
  return found;
}

/** The clone count that jscpd finds in source files. */
function measureDuplication() {
  const output = mkdtempSync(join(tmpdir(), "jscpd-"));
  try {
    run("pnpm", ["dlx", jscpd, "--min-lines", "12", "--min-tokens", "100", "--reporters", "json", "--output", output, "--ignore", jscpdIgnore.join(","), "."]);
    return JSON.parse(readFileSync(join(output, "jscpd-report.json"), "utf8")).statistics.total.clones;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

const checks = {
  complexity: {
    measure: measureComplexity,
    rises: (baseline, current) =>
      Object.entries(current).flatMap(([key, value]) => {
        if (!Array.isArray(value)) return value > (baseline[key] ?? maxComplexity) ? [`${key} has complexity ${value}${baseline[key] ? `, up from ${baseline[key]}` : `, above the limit of ${maxComplexity}`}. Split it by branch.`] : [];
        const allowed = baseline[key] ?? [];
        return value.some((complexity, index) => complexity > (allowed[index] ?? maxComplexity)) ? [`${key} has functions of complexity ${value.join(", ")}; the baseline allows ${allowed.join(", ") || "none"}. Split the new or worse one by branch.`] : [];
      }),
  },
  "dead-code": {
    measure: measureDeadCode,
    rises: (baseline, current) =>
      Object.keys(current)
        .filter((key) => !(key in baseline))
        .map((key) => `${key} is unreachable. Delete it or call it.`),
  },
  duplication: {
    measure: measureDuplication,
    rises: (baseline, current) => (current > baseline ? [`jscpd found ${current} clones, up from ${baseline}. Reuse the existing code.`] : []),
  },
};

export const rises = (name, baseline, current) => checks[name].rises(baseline, current);

if (import.meta.main) {
  const name = process.argv[2];
  if (!Object.hasOwn(checks, name)) {
    console.error(`usage: analysis.mjs ${Object.keys(checks).join("|")} [--write]`);
    process.exit(2);
  }
  const baselines = JSON.parse(readFileSync(baselineFile, "utf8"));
  const current = checks[name].measure();
  const failures = name in baselines ? rises(name, baselines[name], current) : [];
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else if (process.argv.includes("--write")) {
    writeFileSync(baselineFile, `${JSON.stringify({ ...baselines, [name]: current }, null, 2)}\n`);
    execFileSync("pnpm", ["exec", "oxfmt", baselineFile], { cwd: repositoryRoot, stdio: "inherit" });
    console.log(`${name} baseline lowered to the current numbers.`);
  } else {
    console.log(`${name} holds the baseline.`);
  }
}
