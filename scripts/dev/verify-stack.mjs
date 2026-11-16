import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { resolveDevConfig, probePort } from "./config.mjs";
import { readManifest, validateOwnedPid } from "./ownership.mjs";
import { runChecked } from "./chalk-resources.mjs";
import { containerNames } from "./containers.mjs";

const config = resolveDevConfig();
const serviceRecords = (manifest) => Object.fromEntries(manifest.services);

async function waitForReady(predicate = () => true) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const manifest = await readManifest(config);
    if (["failed", "reload-failed"].includes(manifest?.state)) throw new Error(`Runtime failed: ${JSON.stringify(manifest.failure)}`);
    if (manifest?.state === "ready" && predicate(manifest)) return manifest;
    await delay(100);
  }
  throw new Error("Timed out waiting for the reloaded stack to become ready");
}

async function verifyReload(service) {
  const source = service === "api" ? "apps/api/cmd/main.go" : "apps/sync/lib/chalk_sync/application.ex";
  const before = await waitForReady();
  const original = await readFile(source, "utf8");
  const started = Date.now();
  let changed;
  try {
    await writeFile(source, `${original}\n${service === "api" ? "//" : "#"} local reload proof\n`);
    changed = await waitForReady((manifest) => serviceRecords(manifest)[service].pid !== serviceRecords(before)[service].pid);
    assert.equal((await fetch(`${config.urls[service]}/readyz`)).status, 200);
    console.log(JSON.stringify({ service, reloadMs: Date.now() - started, beforePid: serviceRecords(before)[service].pid, afterPid: serviceRecords(changed)[service].pid }));
  } finally {
    await writeFile(source, original);
    if (changed) await waitForReady((manifest) => serviceRecords(manifest)[service].pid !== serviceRecords(changed)[service].pid);
  }
}

async function verifyStopped(before, phase) {
  for (const [service, record] of before.services) assert.equal(await validateOwnedPid(record.pid, { expectedCommand: record.expectedCommand }), false, `${service} still owns a live process after ${phase}`);
  for (const [name, port] of Object.entries(before.ports || config.ports)) {
    const deadline = Date.now() + 10000;
    while (!(await probePort(port)).available && Date.now() < deadline) await delay(100);
    assert.equal((await probePort(port)).available, true, `${name}:${port} is busy after ${phase}`);
  }
  for (const name of [containerNames(config).api, containerNames(config).sync]) {
    try {
      await runChecked("docker", ["inspect", name]);
      assert.fail(`${name} still exists after ${phase}`);
    } catch (error) {
      if (error.cause?.code !== 1) throw error;
    }
  }
  console.log(`${phase}: all owned processes, service containers, and ports released`);
}

if (process.argv[2] === "--network") {
  const challenge = randomBytes(16).toString("hex");
  const server = createServer((_request, response) => response.end(challenge));
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  try {
    const { stdout } = await runChecked("docker", ["exec", containerNames(config).api, "curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "10", `http://host.docker.internal:${server.address().port}/probe`]);
    assert.equal(stdout, challenge);
    assert.equal((await fetch(`${config.urls.api}/readyz`)).status, 200);
    console.log("network: host-to-container and container-to-host requests passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} else if (process.argv[2] === "--reload") {
  for (const service of ["api", "sync"]) await verifyReload(service);
} else if (process.argv[2] === "--teardown") {
  const before = await readManifest(config);
  try {
    await runChecked("pnpm", ["dev:stop"], { cwd: config.root });
    await verifyStopped(before, "stop");
  } finally {
    await runChecked("pnpm", ["dev:down"], { cwd: config.root });
  }
  await verifyStopped(before, "down");
} else throw new Error("Usage: node scripts/dev/verify-stack.mjs --network|--reload|--teardown");
