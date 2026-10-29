import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";

const [mode = "fixed", count = "50", port = "18888"] = process.argv.slice(2);
assert(["baseline", "fixed"].includes(mode));
const iterations = Number(count);
assert(Number.isInteger(iterations) && iterations > 0);
const directory = await mkdtemp(resolve(tmpdir(), "chalk-pages-proxy-"));
const output = [];
let child;
let failures = 0;
const boots = new Set();
try {
  await mkdir(resolve(directory, "public"));
  await writeFile(resolve(directory, "wrangler.toml"), 'name="chalk-proxy-proof"\ncompatibility_date="2024-12-01"\npages_build_output_dir="public"\n');
  await writeFile(resolve(directory, "public/_worker.js"), "let boot; let requests=0; export default { fetch() { boot ??= crypto.randomUUID(); return Response.json({boot, requests: ++requests}) } }");
  child = spawn(mode === "baseline" ? "pnpm" : process.execPath, mode === "baseline" ? ["exec", "wrangler", "pages", "dev", "public", "--cwd", directory, "--port", port, "--inspector-port", "0", "--log-level", "debug"] : [resolve(import.meta.dirname, "pages-runtime.mjs"), directory, port, "{}"], {
    cwd: resolve(import.meta.dirname, "../.."),
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => output.push(chunk.toString()));
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(child.exitCode, null, output.join(""));
    try {
      ready = (await fetch(`${origin}/ready`)).ok;
    } catch {}
    if (ready) break;
    await delay(200);
  }
  assert(ready, output.join(""));
  const started = performance.now();
  for (let run = 0; run < iterations; run++) {
    // Align with KJ's five-second keep-alive boundary in the dev proxy chain.
    await delay(Math.max(0, started + run * 5000 - performance.now()));
    try {
      const response = await fetch(`${origin}/dashboard-api/call`, { method: "POST", body: "{}" });
      const body = await response.text();
      if (response.ok) {
        const result = JSON.parse(body);
        boots.add(result.boot);
        if (mode === "fixed") assert.equal(result.requests, run + 2, "Each POST must execute exactly once after the readiness GET");
      } else {
        assert.equal(response.status, 503);
        assert.match(body, /Your worker restarted mid-request/);
        failures++;
        console.log("PROXY_FAILURE", run, response.status, body);
      }
    } catch (error) {
      if (error.cause?.code !== "UND_ERR_SOCKET") throw error;
      failures++;
      console.log("PROXY_SOCKET_FAILURE", run, error.cause.message);
    }
  }
  assert.equal(boots.size, 1, "The worker must not actually restart");
  console.log("PAGES_PROXY_PROOF", JSON.stringify({ mode, iterations, failures, workerInstances: boots.size }));
  if (mode === "fixed") assert.equal(failures, 0);
  else assert(failures > 0, "The baseline must reproduce the stale-connection failure");
} finally {
  if (child?.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid, "SIGTERM");
    await once(child, "exit");
  }
  console.log("PAGES_LOG", output.join(""));
  await rm(directory, { recursive: true, force: true });
}
