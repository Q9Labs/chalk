// Disposable local stack only. The SFU file is supplied privately over SSH.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolveDevConfig } from "../dev/config.mjs";
import { createChalkSupervisor } from "../dev/chalk.mjs";

const credentials = JSON.parse(await readFile(process.env.CHALK_CLASS_SFU_FILE, "utf8"));
assert.equal(credentials.environment, "development");
assert.equal(credentials.source, "chalk-local-dev");
assert.ok(credentials.appId && credentials.appSecret);
const command = promisify(execFile);
const postgres = `chalk-class-${randomUUID()}`;
const config = resolveDevConfig({
  env: { ...process.env, CHALK_DEV_READINESS_TIMEOUT_MS: "300000", CHALK_POSTGRES_CONTAINER: postgres, CHALK_POSTGRES_VOLUME: postgres, CHALK_REDIS_CONTAINER: "chalk-class-redis", CHALK_REDIS_VOLUME: "chalk-class-redis" },
  requiredTools: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl"],
  secretResolver: async () => credentials,
});
// The web router uses a pathless _space layout; do not rely on dev's old route scanner.
const runtime = createChalkSupervisor({ ...config, webJoinPath: "/space" });
let child;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => (child ? child.kill(signal) : void runtime.stop()));
try {
  // dev-postgres's pg_isready can accept the entrypoint's temporary server before
  // POSTGRES_DB exists. Wait for PID 1 to be the final server, as the gate does.
  await command("docker", ["run", "--name", postgres, "-e", "POSTGRES_DB=chalk", "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_PASSWORD=postgres", "-e", "POSTGRES_INITDB_ARGS=--data-checksums", "-p", `127.0.0.1:${config.ports.postgres}:5432`, "-d", "postgres:18.3-alpine"]);
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await command("docker", ["exec", postgres, "sh", "-c", 'test "$(cat /proc/1/comm)" = postgres && psql -U postgres -d chalk -Atqc "select 1"']).catch(() => null);
    if (result?.stdout.trim() === "1") {
      ready = true;
      break;
    }
    await wait(500);
  }
  assert.ok(ready, "Final PostgreSQL server was not ready within 60 seconds");
  await runtime.start();
  assert.equal(runtime.status().state, "ready");
  const run = process.env.CHALK_CLASS_RUN ?? "1";
  const output = `.private/class-checklist/run-${run}`;
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/cases.jsonl`, "");
  const code = await new Promise((resolve, reject) => {
    child = spawn("pnpm", ["exec", "e2e", "run", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, CHALK_CLASS_CHECKLIST: "1", CHALK_CLASS_OUTPUT: output, CHALK_PROOF_WEB_URL: config.urls.web },
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  try {
    await runtime.stop();
  } finally {
    await command("docker", ["rm", "-f", "--volumes", postgres]);
  }
}
