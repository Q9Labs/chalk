#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const scriptName = process.argv[2];

if (!scriptName) {
  console.error("Usage: node scripts/dev-log.mjs <script-name> [args...]");
  process.exit(1);
}

const logPath = resolve(process.cwd(), ".logs/dev-server.log");
mkdirSync(dirname(logPath), { recursive: true });

const log = createWriteStream(logPath, { flags: "a" });
const startedAt = new Date().toISOString();
const extraArgs = process.argv.slice(3);

log.write(`\n\n===== ${startedAt} pnpm run ${scriptName}${extraArgs.length ? ` ${extraArgs.join(" ")}` : ""} =====\n`);
console.log(`[dev-log] Mirroring dev server output to ${logPath}`);

const child = spawn("pnpm", ["run", scriptName, ...extraArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("close", (code, signal) => {
  log.write(`\n===== exited ${new Date().toISOString()} code=${code ?? ""} signal=${signal ?? ""} =====\n`);
  log.end(() => {
    if (signal === "SIGINT") process.exit(130);
    if (signal === "SIGTERM") process.exit(143);
    process.exit(code ?? 0);
  });
});
