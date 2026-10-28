// Disposable local stack only. The SFU file is supplied privately over SSH.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { resolveDevConfig } from "../dev/config.mjs";
import { createChalkSupervisor } from "../dev/chalk.mjs";

const credentials = JSON.parse(await readFile(process.env.CHALK_CLASS_SFU_FILE, "utf8"));
assert.equal(credentials.environment, "development");
assert.equal(credentials.source, "chalk-local-dev");
assert.ok(credentials.appId && credentials.appSecret);
const config = resolveDevConfig({
  env: { ...process.env, CHALK_DEV_READINESS_TIMEOUT_MS: "300000" },
  requiredTools: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl"],
  secretResolver: async () => credentials,
});
// The web router uses a pathless _space layout; do not rely on dev's old route scanner.
const runtime = createChalkSupervisor({ ...config, webJoinPath: "/space" });
let child;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => (child ? child.kill(signal) : void runtime.stop()));
try {
  await runtime.start();
  assert.equal(runtime.status().state, "ready");
  const run = process.env.CHALK_CLASS_RUN ?? "1";
  const output = `.private/class-checklist/run-${run}`;
  await mkdir(output, { recursive: true });
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
  await runtime.stop();
}
