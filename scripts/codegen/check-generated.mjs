import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Each entry reuses an existing check. None needs Postgres or Docker.
const checks = [
  { name: "ContractIR", command: ["pnpm", "--filter", "@chalk/contract-fixture-proof", "check-generated"] },
  { name: "OpenAPI, SDK, and Sync contract", command: ["pnpm", "run", "check:sdk-generated"] },
  { name: "API design", command: ["pnpm", "run", "check:api-design"] },
  { name: "sqlc", command: ["bash", "apps/api/scripts/db-generate.sh", "check"] },
  { name: "Migration LatestVersion", command: ["node", "scripts/codegen/migration-latest-version.mjs"] },
  { name: "Diagnostics fixtures", command: ["pnpm", "--filter", "@q9labsai/diagnostics-contracts", "fixtures:check"] },
  { name: "Tracker views", command: ["pnpm", "run", "check:tracker"] },
  // A reviewed baseline, not generated output: `regen` never touches it. It runs here because it is fast.
  { name: "Language ratchet", command: ["pnpm", "run", "language:ratchet"], fix: "pnpm run language:ratchet:update after review" },
];

function run({ name, command, fix }) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ name, fix, ok: false, output: `${error.message}\n` }));
    child.on("close", (code) => resolve({ name, fix, ok: code === 0, output }));
  });
}

const started = Date.now();
const results = await Promise.all(checks.map(run));
const failures = results.filter((result) => !result.ok);

for (const failure of failures) {
  console.error(`\n--- ${failure.name} is out of date ---\n${failure.output.trimEnd()}`);
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length > 0) {
  const fixes = new Set(failures.map((failure) => failure.fix ?? "pnpm run regen"));
  console.error(`\ncheck:generated failed (${failures.map((failure) => failure.name).join(", ")}). Fix: ${[...fixes].join("; ")}`);
  process.exitCode = 1;
} else {
  console.log(`check:generated passed: ${results.length} checks in ${seconds}s`);
}
