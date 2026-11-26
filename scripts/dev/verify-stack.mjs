import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { resolveDevConfig, probePort } from "./config.mjs";
import { waitForSeededSpaceIdle } from "./chalk-signin.mjs";
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
    assert.equal(serviceRecords(changed).web.pid, serviceRecords(before).web.pid, "backend reload must preserve the web proxy process");
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

async function verifyDashboardArtifacts() {
  const artifacts = JSON.parse(await readFile(`${config.runtimeRoot}/dashboard-artifacts.json`, "utf8"));
  const [key, expected] = Object.entries(artifacts).find(([, value]) => typeof value === "object");
  const { stdout } = await runChecked("docker", ["exec", containerNames(config).api, "curl", "--noproxy", "*", "--fail", "--silent", "--max-time", "10", `http://127.0.0.1:${config.ports.web}/__local-dashboard-artifacts${key}`]);
  assert.deepEqual(JSON.parse(stdout), expected, "the API container must read its mounted dashboard artifacts");
  assert.deepEqual(await (await fetch(`${config.urls.web}/__local-dashboard-artifacts${key}`)).json(), expected);
  const seed = JSON.parse(await readFile(config.seedPath, "utf8"));
  const { stdout: row } = await runChecked("docker", ["exec", config.postgres.container, "psql", "-U", "postgres", "-d", config.databaseName, "-At", "-F", ",", "-c", `select tenant_id,id from transcriptions where episode_id='${expected.episodeId}' and status='complete' limit 1`]);
  const [tenantId, transcriptId] = row.trim().split(",");
  const url = `${config.urls.api}/v1/tenants/${tenantId}/transcripts/${transcriptId}`;
  const options = { headers: { Authorization: `Bearer ${seed.systemToken}` } };
  const document = await fetch(`${url}/document`, options);
  assert.equal(document.status, 200, "API transcript document reads must work through the mounted object store");
  assert.equal((await document.json()).cues[0].text, expected.cues[0].text);
  const text = await fetch(`${url}/text`, options);
  assert.equal(text.status, 200);
  assert.ok((await text.text()).includes(expected.cues[0].text));
  const { stdout: mounts } = await runChecked("docker", ["inspect", "--format", "{{json .Mounts}}", containerNames(config).api]);
  assert.equal(JSON.parse(mounts).find(({ Destination }) => Destination === "/dashboard-artifacts").RW, true);
}

async function verifyContainerPublications() {
  for (const name of [containerNames(config).api, containerNames(config).sync, config.postgres.container, config.redis.container]) {
    const { stdout } = await runChecked("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", name]);
    for (const bindings of Object.values(JSON.parse(stdout))) {
      for (const binding of bindings || []) assert.ok(["127.0.0.1", "::1"].includes(binding.HostIp), `${name} publishes ${binding.HostPort} on ${binding.HostIp}`);
    }
  }
}

async function verifyHostIsolation() {
  const addresses = [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter((entry) => entry && !entry.internal && entry.family === "IPv4")
        .map(({ address }) => address),
    ),
  ];
  assert.ok(addresses.length, "isolation proof needs a non-loopback interface");
  const ports = [config.ports.api, config.ports.sync, config.ports.postgres, config.ports.redis, config.ports.providerBridge, config.ports.sfuMedia];
  if (!config.publicOrigin) ports.push(config.ports.web);
  for (const host of addresses) for (const port of ports) await assertUnreachable(host, port);
  console.log(`isolation: ${ports.length} host ports refuse connections on ${addresses.length} non-loopback interfaces`);
}

function assertUnreachable(host, port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const unavailable = () => {
      socket.destroy();
      resolve();
    };
    socket.once("error", unavailable);
    socket.setTimeout(1500, unavailable);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`${host}:${port} is reachable outside loopback`));
    });
  });
}

if (process.argv[2] === "--network") {
  await verifyDashboardArtifacts();
  await verifyContainerPublications();
  await verifyHostIsolation();
  assert.equal((await fetch(`${config.urls.api}/readyz`)).status, 200);
  console.log("network: mounted artifact reads, API transcript reads and loopback-only host bindings passed");
} else if (process.argv[2] === "--reload") {
  for (const service of ["api", "sync"]) await verifyReload(service);
  // The Doctor guest has left, but a reload can interrupt its Episode cleanup.
  const seed = JSON.parse(await readFile(config.seedPath, "utf8"));
  await waitForSeededSpaceIdle({ origin: config.urls.api, seed });
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
