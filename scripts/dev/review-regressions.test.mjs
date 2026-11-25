import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateOwnedPid } from "./ownership.mjs";
import { reverseAndroidPorts } from "./android.mjs";
import { containerArguments, containerEnvironment } from "./containers.mjs";
import { dashboardArtifactBindings } from "./dashboard-seed.mjs";
import { previewAudio, writeDashboardArtifacts } from "./dashboard-artifacts.mjs";
import { executeDevCommand } from "./exec.mjs";
import { preflight, probePort, resolveDevConfig } from "./config.mjs";
import { startChalkSfu } from "./chalk-sfu.mjs";
import { spawnCommand, killTree } from "../lib/platform.mjs";

const config = resolveDevConfig({ env: {} });

test("dev SFU publishes reachable media only when an announce address is set", async () => {
  for (const announceIP of [undefined, "192.0.2.42"]) {
    const dev = resolveDevConfig({ env: { PUBLIC_ORIGIN: "https://chalk.example.test", CHALK_DEV_SFU_ANNOUNCE_IP: announceIP } });
    let launch;
    await startChalkSfu(dev, {
      network: "test",
      versions: { go: "test" },
      runResource: async (_command, args) => {
        if (args.includes("--detach")) launch = args;
      },
    });
    const bind = announceIP ? "0.0.0.0" : "127.0.0.1";
    const port = dev.ports.sfuMedia;
    assert.deepEqual(
      launch.flatMap((arg, index) => (arg === "--publish" ? [launch[index + 1]] : [])),
      [`${bind}:${port}:${port}/udp`, `${bind}:${port}:${port}/tcp`],
    );
    assert.ok(launch.includes(`SFU_ANNOUNCE_IPS=${announceIP || bind}`));
    assert.ok(launch.includes(`SFU_ICE_LOOPBACK=${!announceIP}`));
  }
});

test("dev SFU rejects announce addresses that cannot identify an IPv4 host", () => {
  for (const address of ["chalk.example.test", "::1", "127.0.0.2", "0.0.0.0", "239.0.0.1"]) {
    assert.throws(() => resolveDevConfig({ env: { CHALK_DEV_SFU_ANNOUNCE_IP: address } }), /CHALK_DEV_SFU_ANNOUNCE_IP must be a non-loopback unicast IPv4 address/);
  }
});

test("dev preflight rejects an occupied SFU UDP port before starting containers", async () => {
  const listener = createSocket("udp4");
  listener.bind(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  const dev = { ...resolveDevConfig({ env: { CHALK_DEV_SFU_ANNOUNCE_IP: "192.0.2.42" } }), ports: { sfuMedia: port } };
  const options = {
    requiredTools: [],
    probe: (port, host, transport) => (transport === "udp" ? probePort(port, host, transport) : { available: true }),
  };
  try {
    await assert.rejects(preflight(dev, options), new RegExp(`ports already in use: sfuMedia:${port}/udp`));
  } finally {
    await new Promise((done) => listener.close(done));
  }
  assert.equal((await preflight(dev, options)).ok, true);
});

test("dev preflight reports a denied SFU UDP bind without claiming another listener", async () => {
  const dev = { ...resolveDevConfig({ env: {} }), ports: { sfuMedia: 40000 } };
  const error = Object.assign(new Error("bind EACCES 127.0.0.1:40000"), { code: "EACCES" });
  await assert.rejects(
    preflight(dev, {
      requiredTools: [],
      probe: (_port, _host, transport) => (transport === "udp" ? { available: false, error } : { available: true }),
    }),
    /cannot bind sfuMedia:40000\/udp: bind EACCES/,
  );
});

test("ownership accepts a real forward-slash Node invocation with Windows recorded separators", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-owner-"));
  let child;
  try {
    await mkdir(join(root, "scripts", "dev"), { recursive: true });
    await writeFile(join(root, "scripts", "dev", "hold.mjs"), 'import {writeFileSync} from "node:fs";writeFileSync("ready", "yes");setInterval(()=>{},1000);');
    child = spawnCommand(process.execPath, ["scripts/dev/hold.mjs"], { cwd: root, detached: process.platform !== "win32", stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      for (let count = 0; count < 100; count++) {
        if (await readFile(join(root, "ready"), "utf8").catch(() => "")) break;
        await delay(25);
      }
      assert.equal(await validateOwnedPid(child.pid, { expectedCommand: "scripts\\dev\\hold.mjs", platform: "win32" }), true);
      assert.equal(await validateOwnedPid(child.pid, { expectedCommand: "scripts\\dev\\different.mjs", platform: "win32" }), false);
    } finally {
      killTree(child);
      await exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adb CRLF listings forward the API, Metro and media ports for every authorized device", async () => {
  const forwarded = [];
  await reverseAndroidPorts({
    env: { CHALK_DEV_API_PORT: "18080", RCT_METRO_PORT: "18081", CHALK_DEV_SFU_MEDIA_PORT: "18082" },
    run: async (_command, args) => {
      if (args[0] === "devices") return { stdout: "List of devices attached\r\nemulator-5554\tdevice\r\nusb-123\tdevice\r\nlocked\tunauthorized\r\n" };
      if (args.includes("reverse")) forwarded.push(args);
      return { stdout: "" };
    },
  });
  assert.deepEqual(forwarded, [
    ["-s", "emulator-5554", "reverse", "tcp:18080", "tcp:18080"],
    ["-s", "emulator-5554", "reverse", "tcp:18081", "tcp:18081"],
    ["-s", "emulator-5554", "reverse", "tcp:18082", "tcp:18082"],
    ["-s", "usb-123", "reverse", "tcp:18080", "tcp:18080"],
    ["-s", "usb-123", "reverse", "tcp:18081", "tcp:18081"],
    ["-s", "usb-123", "reverse", "tcp:18082", "tcp:18082"],
  ]);
});

test("container artifact reads stay internal without changing browser download URLs", () => {
  const bindings = dashboardArtifactBindings(config);
  const env = containerEnvironment(config, "api", bindings);
  assert.equal(env.CHALK_R2_ENDPOINT, bindings.CHALK_R2_ENDPOINT);
  const internal = new URL(env.CHALK_R2_INTERNAL_ENDPOINT);
  assert.equal(internal.hostname, "127.0.0.1");
  assert.equal(internal.port, String(config.ports.web));
  const args = containerArguments(config, "api", { image: "test", env });
  assert.ok(args.includes(`type=bind,source=${config.runtimeRoot}/dashboard-artifacts,target=/dashboard-artifacts,readonly`));
  for (let index = 0; index < args.length; index++) if (args[index] === "--publish") assert.ok(args[index + 1].startsWith("127.0.0.1:"));
  assert.equal(internal.pathname, "/__local-dashboard-artifacts");
  const remote = containerEnvironment(config, "api", { CHALK_R2_ENDPOINT: "https://artifacts.example.test" });
  assert.equal(remote.CHALK_R2_INTERNAL_ENDPOINT, undefined);
});

for (const signal of [undefined, "SIGINT", "SIGTERM"]) {
  test(`dev:exec enables database suites and removes its database after ${signal || "normal failure"}`, async () => {
    const signals = new EventEmitter();
    const databases = new Set();
    let child;
    let stopped = false;
    const code = await executeDevCommand("api", ["go", "test", "./..."], {
      config,
      environment: {},
      signals,
      prepare: async () => ({ go: "test", erlang: "test", elixir: "test" }),
      run: async (_command, args) => {
        if (args.includes("createdb")) databases.add(args.at(-1));
        if (args[0] === "stop") {
          stopped = true;
          killTree(child);
        }
        if (args.includes("dropdb")) {
          assert.ok(child.exitCode !== null || child.signalCode !== null, "the test process exits before database removal");
          databases.delete(args.at(-1));
        }
      },
      spawn: (_command, args, options) => {
        assert.ok(args.includes("--name"));
        const url = options.env.CHALK_DATABASE_URL;
        assert.equal(options.env.CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL, url);
        assert.equal(options.env.CHALK_WEBHOOK_TEST_DATABASE_URL, url);
        assert.equal(options.env.CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL, url);
        assert.equal(options.env.CHALK_SYNC_TEST_DATABASE_URL, url);
        assert.ok(databases.has(new URL(url).pathname.slice(1)));
        child = spawnCommand(process.execPath, ["-e", signal ? "setInterval(()=>{},1000)" : "process.exit(7)"], { detached: process.platform !== "win32", stdio: "ignore" });
        if (signal) setImmediate(() => signals.emit(signal));
        return child;
      },
    });
    assert.equal(code, signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 7);
    assert.equal(stopped, Boolean(signal));
    assert.equal(databases.size, 0);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  });
}

test("the local artifact server stores bytes and object metadata for finalize", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-artifact-server-"));
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn("python3", ["scripts/dev/artifact-server.py", String(port), root], { stdio: "ignore" });
  try {
    const base = `http://127.0.0.1:${port}/__local-dashboard-artifacts/local-dashboard/test.pdf`;
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt++) {
      ready = await fetch(base, { method: "HEAD" }).then(
        () => true,
        () => false,
      );
      if (!ready) await delay(50);
    }
    assert.equal(ready, true);
    const put = await fetch(base, {
      method: "PUT",
      body: "abc",
      headers: { "Content-Type": "application/pdf", "x-amz-meta-chalk-upload-id": "upload-one", "x-amz-checksum-sha256": "digest" },
    });
    assert.equal(put.status, 200);
    const got = await fetch(base);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "application/pdf");
    assert.equal(got.headers.get("x-amz-meta-chalk-upload-id"), "upload-one");
    assert.equal(got.headers.get("x-amz-checksum-sha256"), "digest");
    assert.equal(await got.text(), "abc");
    const head = await fetch(base, { method: "HEAD" });
    assert.equal(head.headers.get("content-length"), "3");
    assert.equal((await fetch(base, { method: "DELETE" })).status, 204);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("the mounted artifact directory contains byte-identical JSON/audio and refuses path escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-artifact-files-"));
  try {
    const document = { schemaVersion: "transcript.v1", cues: [{ text: "Local transcript" }] };
    await writeDashboardArtifacts(root, { "/local-dashboard/transcript.json": document, "/local-dashboard/preview.wav": "preview-audio" });
    const base = join(root, "dashboard-artifacts", "__local-dashboard-artifacts", "local-dashboard");
    assert.equal(await readFile(join(base, "transcript.json"), "utf8"), JSON.stringify(document));
    assert.deepEqual(await readFile(join(base, "preview.wav")), previewAudio());
    await assert.rejects(writeDashboardArtifacts(root, { "/../../escape.json": {} }), /Invalid local artifact key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
