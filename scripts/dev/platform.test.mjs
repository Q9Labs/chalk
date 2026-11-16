import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveDevConfig, parseArguments, preflight } from "./config.mjs";
import { spawnService, stopProcessGroup } from "./process.mjs";
import { validateOwnedPid } from "./ownership.mjs";
import { runChecked } from "./chalk-resources.mjs";
import { openRuntimeControl, requestRuntimeStop } from "./control.mjs";
import { containerArguments, containerEnvironment } from "./containers.mjs";
import { parseInstallArguments, connectedSerial } from "./android.mjs";

const credentials = { CHALK_CLOUDFLARE_REALTIME_APP_ID: "test", CHALK_CLOUDFLARE_REALTIME_APP_SECRET: "test" };

test("core preflight needs only Node, pnpm and Docker with supplied SFU credentials", async () => {
  const config = resolveDevConfig({ env: credentials });
  assert.deepEqual(config.requiredTools, ["node", "pnpm", "docker"]);
  await preflight(config, { which: async (tool) => ["node", "pnpm", "docker"].includes(tool), probe: async () => ({ available: true }) });
  assert.ok(resolveDevConfig({ env: {} }).requiredTools.includes("op"));
  assert.ok(!resolveDevConfig({ env: { CHALK_CLOUDFLARE_REALTIME_APP_ID: "one" } }).requiredTools.every((tool) => tool !== "op"));
  for (const profile of ["mobile", "android"]) {
    const mobile = resolveDevConfig({ env: credentials, profile });
    assert.ok(mobile.requiredTools.includes("adb"));
    assert.ok(!mobile.requiredTools.includes("xcrun"));
    assert.equal(parseArguments(["--profile", profile]).profile, profile);
  }
  assert.ok(resolveDevConfig({ env: credentials, profile: "ios" }).requiredTools.includes("xcrun"));
});

test("Windows state uses LOCALAPPDATA, not XDG or the checkout", () => {
  const base = join(tmpdir(), "chalk-local-appdata");
  const config = resolveDevConfig({ platform: "win32", env: { LOCALAPPDATA: base, XDG_STATE_HOME: "wrong" } });
  assert.equal(config.stateRoot, join(base, "chalk"));
  assert.equal(resolveDevConfig({ platform: "win32", home: base, env: {} }).stateRoot, join(base, "AppData", "Local", "chalk"));
});

test("the dev runner starts the real pnpm shim", async () => {
  const result = await runChecked("pnpm", ["--version"]);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("stop kills the child and its listening descendant, with portable ownership checks", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "chalk-tree-"));
  const portFile = join(root, "listener.json");
  const descendant = `const fs=require('fs');const net=require('net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(portFile)},JSON.stringify({pid:process.pid,port:server.address().port})));`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const running = spawnService({ id: "tree", command: process.execPath, args: ["-e", parent] }, { config: { root, logRoot: root, aggregateLog: join(root, "all.log") }, mirror: undefined });
  try {
    let listener;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        listener = JSON.parse(await readFile(portFile, "utf8"));
        break;
      } catch {
        await delay(50);
      }
    }
    assert.ok(listener, "descendant opened its port");
    assert.equal(await validateOwnedPid(running.pid, { expectedCommand: process.execPath }), true);
    assert.equal(await validateOwnedPid(running.pid, { expectedCommand: "not-the-owned-command-123456" }), false);
    assert.equal((await stopProcessGroup(running)).stopped, true);
    const { probePort } = await import("./config.mjs");
    for (let attempt = 0; attempt < 100 && !(await probePort(listener.port)).available; attempt++) await delay(25);
    assert.equal((await probePort(listener.port)).available, true);
  } finally {
    if (!running.exited) await stopProcessGroup(running).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("local control refuses an unauthenticated stop and accepts the private owner token", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "chalk-control-"));
  let stopped = false;
  const control = await openRuntimeControl({ runtimeRoot }, () => {
    stopped = true;
  });
  try {
    const { port } = JSON.parse(await readFile(join(runtimeRoot, "control.json"), "utf8"));
    assert.equal((await fetch(`http://127.0.0.1:${port}/stop`, { method: "POST" })).status, 403);
    assert.equal(stopped, false);
    await assert.rejects(requestRuntimeStop({ runtimeRoot }, process.pid + 1), /does not match/);
    await requestRuntimeStop({ runtimeRoot }, process.pid);
    assert.equal(stopped, true);
  } finally {
    await control.close();
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("containers use their private network and paths, never host build output", () => {
  const config = resolveDevConfig({ env: credentials });
  const env = containerEnvironment(config, "sync", { CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE: config.identity.syncKey });
  assert.equal(env.CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE, "/workspace/.private/chalk-dev/identity/sync-client-key.pem");
  assert.equal(env.CHALK_SYNC_PROVIDER_BRIDGE_URL, `https://api:${config.ports.providerBridge}`);
  assert.ok(!env.CHALK_DATABASE_URL.includes("127.0.0.1"));
  const args = containerArguments(config, "sync", { image: "fixture", env });
  assert.ok(args.includes("host.docker.internal:host-gateway"));
  assert.ok(args.some((arg) => arg.includes("type=volume") && arg.endsWith("target=/workspace/apps/sync/_build")));
  assert.ok(args.some((arg) => arg.includes("type=volume") && arg.endsWith("target=/workspace/apps/sync/deps")));
});

test("Android device selection and install flags do not require a shell", async () => {
  assert.equal(await connectedSerial(async () => ({ stdout: "List of devices attached\r\nemulator-5554\tdevice\r\n" }), {}), "emulator-5554");
  await assert.rejects(
    connectedSerial(async () => ({ stdout: "List of devices attached\n" }), {}),
    /No connected adb/,
  );
  assert.equal(parseInstallArguments(["--release", "--install", "--no-launch"]).variant, "release");
  assert.throws(() => parseInstallArguments(["--pair", "ip:port"]), /requires --code/);
});
