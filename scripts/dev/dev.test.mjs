import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments, preflight, resolveDevConfig } from "./config.mjs";
import { acquireMachineLease, readManifest, writeManifest, writeOwner } from "./ownership.mjs";
import { stopCommand } from "./commands.mjs";
import { createLogMux, tailLog, waitForFileReady, waitForHTTPReady } from "./process.mjs";
import { createReloadCoordinator, createSourcePoller, dependencyOrder } from "./reload.mjs";
import { createSupervisor } from "./supervisor.mjs";
import { createResourceManager } from "./chalk-resources.mjs";
import { resolveLocalSfuCredentials } from "./secrets.mjs";
import { generateSigningIdentity, identityPaths } from "./identity.mjs";
import { FailureKind, RuntimeState } from "./model.mjs";

async function tempConfig() {
  const root = await mkdtemp(join(tmpdir(), "chalk-dev-test-"));
  const config = resolveDevConfig({ root, cwd: root, requiredTools: [], home: root, allowBusyPorts: Object.keys({ api: 8080, sync: 4100, web: 3070, bff: 3071, postgres: 5432, redis: 6380, grafana: 3000, broker: 8787 }) });
  return { root, config };
}

test("CLI parser keeps command, profile, and logs service separate", () => {
  assert.deepEqual(parseArguments(["start", "--profile=mobile", "--fresh"]), { command: "start", profile: "mobile", service: undefined, fresh: true, yes: false });
  assert.deepEqual(parseArguments(["logs", "--", "api"]), { command: "logs", profile: "core", service: "api", fresh: false, yes: false });
  assert.throws(() => parseArguments(["--profile", "tablet"]), { kind: FailureKind.CONFIG });
});

test("service readiness defaults to a bounded two-minute cold-start window", async () => {
  const { root, config } = await tempConfig();
  try {
    assert.equal(config.timeouts.readinessMs, 120000);
    assert.equal(config.timeouts.stopTimeoutMs, 120000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight reports missing tools and busy ports through typed failures", async () => {
  const { root, config } = await tempConfig();
  try {
    await assert.rejects(preflight(config, { which: async () => false, probe: async () => ({ available: true }), requiredTools: ["node"] }), { kind: FailureKind.MISSING_TOOL });
    await assert.rejects(preflight(config, { which: async () => true, probe: async () => ({ available: false }), allowBusyPorts: new Set() }), { kind: FailureKind.BUSY_PORT });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("machine lease is exclusive and manifest writes redact secrets", async () => {
  const { root, config } = await tempConfig();
  try {
    const lease = await acquireMachineLease(config, { isAlive: async () => true });
    await assert.rejects(acquireMachineLease(config, { isAlive: async () => true, recoverStale: false }), { kind: FailureKind.OWNERSHIP_CONFLICT });
    await writeManifest(config, { state: "ready", app_secret: "keep-out", nested: { token: "also-out" } });
    const body = await readFile(config.manifestPath, "utf8");
    assert.doesNotMatch(body, /keep-out|also-out/);
    assert.equal((await readManifest(config)).state, "ready");
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identity generation writes Ed25519 PEM and raw public keyring", async () => {
  const { root, config } = await tempConfig();
  try {
    const paths = identityPaths(config);
    const identity = await generateSigningIdentity({ paths, kid: "test-kid" });
    const keyring = JSON.parse(await readFile(paths.signingPublicKeyring, "utf8"));
    assert.equal(identity.kid, "test-kid");
    assert.match(await readFile(paths.signingPrivateKey, "utf8"), /BEGIN PRIVATE KEY/);
    assert.equal(keyring["test-kid"].length, 43);
    assert.equal(identity.rawPrivateKey.length, 86);
    const rawPrivateBytes = Buffer.from(identity.rawPrivateKey, "base64url");
    const rawPublicBytes = Buffer.from(keyring["test-kid"], "base64url");
    assert.equal(rawPrivateBytes.length, 64);
    assert.equal(rawPublicBytes.length, 32);
    assert.deepEqual(rawPrivateBytes.subarray(32), rawPublicBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SFU resolver enumerates vaults and passes vault on item get", async () => {
  const gets = [];
  const result = await resolveLocalSfuCredentials({
    enumerateVaults: async () => [{ id: "vault-1", name: "Chalk Local" }],
    enumerateItems: async () => [{ id: "item-1", category: "API_CREDENTIAL", title: "Chalk SFU local", tags: ["local"] }],
    getItem: async (input) => {
      gets.push(input);
      return {
        fields: [
          { id: "username", label: "app_id", value: "id-1" },
          { id: "password", label: "app_secret", value: "secret-1" },
        ],
      };
    },
  });
  assert.deepEqual(gets, [{ vault: { id: "vault-1", name: "Chalk Local" }, itemId: "item-1" }]);
  assert.deepEqual(result.redactions, ["id-1", "secret-1"]);
  const productionItem = { id: "prod", category: "API_CREDENTIAL", title: "Chalk SFU production", tags: ["chalk", "sfu", "production"] };
  await assert.rejects(resolveLocalSfuCredentials({ enumerateVaults: async () => [{ id: "v" }], enumerateItems: async () => [productionItem], getItem: async () => ({}) }), { kind: FailureKind.CONFIG });
  await assert.rejects(resolveLocalSfuCredentials({ enumerateVaults: async () => [{ id: "v" }], enumerateItems: async () => [productionItem], selectCandidate: () => true, getItem: async () => ({}) }), { kind: FailureKind.CONFIG, message: /cannot be selected/ });
  await assert.rejects(
    resolveLocalSfuCredentials({
      enumerateVaults: async () => [{ id: "v" }],
      enumerateItems: async () => [
        { id: "1", title: "API_CREDENTIAL", tags: ["chalk", "sfu", "local"] },
        { id: "2", title: "API_CREDENTIAL", tags: ["chalk", "sfu", "local"] },
      ],
      getItem: async () => ({}),
    }),
    { kind: FailureKind.CONFIG },
  );
});

test("log mux redacts values and HTTP readiness retries", async () => {
  const { root, config } = await tempConfig();
  try {
    const mux = createLogMux({ service: "api", logRoot: config.logRoot, aggregatePath: config.aggregateLog, redactions: ["app-id-value", "secret-value"], mirror: { write() {} } });
    await mux.write("provider app-id-value secret-value\n");
    assert.doesNotMatch(await tailLog(mux.servicePath), /app-id-value|secret-value/);
    let attempts = 0;
    const result = await waitForHTTPReady({ id: "api", readiness: { url: "http://example.test/readyz" } }, { timeoutMs: 100, intervalMs: 1, fetchImpl: async () => ({ status: ++attempts > 1 ? 200 : 503 }) });
    assert.equal(result.ok, true);
    const metro = await waitForHTTPReady({ id: "mobile", readiness: { url: "http://127.0.0.1:8081/status", bodyIncludes: "packager-status:running" } }, { timeoutMs: 100, intervalMs: 1, fetchImpl: async () => ({ status: 200, text: async () => "packager-status:running" }) });
    assert.equal(metro.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file readiness waits for the whiteboard export", async () => {
  let attempts = 0;
  const result = await waitForFileReady(
    { id: "sdk-whiteboard", readiness: { filePath: "/repo/packages/whiteboard/dist/react/index.js" } },
    {
      timeoutMs: 100,
      intervalMs: 1,
      statImpl: async () => {
        attempts += 1;
        if (attempts < 2) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { isFile: () => true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.path, "/repo/packages/whiteboard/dist/react/index.js");
  assert.equal(attempts, 2);
});

test("reload coordinator restarts dependants in dependency order", async () => {
  const specs = [{ id: "db" }, { id: "api", dependsOn: ["db"] }, { id: "web", dependsOn: ["api"] }];
  assert.deepEqual(
    dependencyOrder(specs).map((spec) => spec.id),
    ["db", "api", "web"],
  );
  const calls = [];
  const coordinator = createReloadCoordinator({ serviceSpecs: specs, restart: async (id, action) => calls.push(`${action}:${id}`) });
  await coordinator.request([{ serviceId: "db" }]);
  assert.deepEqual(calls, ["stop:web", "stop:api", "stop:db", "start:db", "start:api", "start:web"]);
});

test("source poller seeds its initial snapshot without restarting services", async () => {
  let version = "initial";
  let scans = 0;
  let initialScan;
  const initialScanDone = new Promise((resolveInitial) => {
    initialScan = resolveInitial;
  });
  const changes = [];
  const poller = createSourcePoller({
    rootsByService: { api: ["/repo"] },
    intervalMs: 1000,
    debounceMs: 0,
    onChange: (entries) => changes.push(entries),
    scanner: async () => {
      scans += 1;
      const snapshot = new Map([["/repo/file.go", version]]);
      if (scans === 1) {
        await Promise.resolve();
        initialScan();
      }
      return snapshot;
    },
  });
  try {
    await initialScanDone;
    await new Promise((resolveNext) => setImmediate(resolveNext));
    assert.equal(changes.length, 0);
    version = "changed";
    await poller.flush();
    await new Promise((resolveNext) => setTimeout(resolveNext, 10));
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0][0], { serviceId: "api", path: "/repo/file.go", relativePath: "file.go" });
  } finally {
    poller.close();
  }
});

test("local resource migration opts into Goose allow-missing without changing the helper", async () => {
  const { root, config } = await tempConfig();
  const calls = [];
  try {
    const manager = createResourceManager(config, {
      docker: async () => undefined,
      runner: async (command, args, options) => {
        calls.push({ command, args, options });
        if (args.at(-1) === "up") throw new Error("stop after migration command assertion");
        return { stdout: "", stderr: "" };
      },
      identityGenerator: async () => ({ kid: "test", rawPrivateKey: "private", publicKeyring: {} }),
    });
    await assert.rejects(manager.start(), /stop after migration command assertion/);
    const migration = calls.find(({ args }) => args.some((arg) => arg.endsWith("db-migrate.sh")));
    assert.deepEqual(migration.args.slice(-2), ["--allow-missing", "up"]);
    assert.equal(config.databaseName, "chalk_dev");
    assert.match(migration.options.env.CHALK_DATABASE_URL, /\/chalk_dev\?/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor starts DAG, persists ready state, and cleans up first failure", async () => {
  const { root, config } = await tempConfig();
  const started = [];
  const stopped = [];
  try {
    const supervisor = createSupervisor(config, {
      serviceSpecs: [{ id: "db" }, { id: "api", dependsOn: ["db"] }],
      preflightFn: async () => {},
      hooks: {
        watch: false,
        startService: async (spec) => {
          started.push(spec.id);
          return { id: spec.id, pid: process.pid + 1, exited: false, logPath: `${spec.id}.log` };
        },
        waitReady: async () => {},
        stopService: async (spec) => {
          stopped.push(spec.id);
        },
      },
    });
    const status = await supervisor.start();
    assert.equal(status.state, RuntimeState.READY);
    assert.deepEqual(started, ["db", "api"]);
    await supervisor.stop();
    assert.deepEqual(stopped, ["api", "db"]);
    assert.equal(supervisor.state, RuntimeState.STOPPED);
    assert.equal((await readManifest(config)).state, RuntimeState.STOPPED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor persists stopping state before delayed teardown", async () => {
  const { root, config } = await tempConfig();
  let releaseStop;
  let stopStarted;
  const stopGate = new Promise((resolveStop) => {
    releaseStop = resolveStop;
  });
  const stopStartedPromise = new Promise((resolveStarted) => {
    stopStarted = resolveStarted;
  });
  try {
    const supervisor = createSupervisor(config, {
      serviceSpecs: [{ id: "api" }],
      preflightFn: async () => {},
      hooks: {
        watch: false,
        startService: async () => ({ id: "api", pid: process.pid + 1, exited: false, logPath: "api.log" }),
        waitReady: async () => {},
        stopService: async () => {
          stopStarted();
          await stopGate;
        },
      },
    });
    await supervisor.start();
    const stopPromise = supervisor.stop();
    await stopStartedPromise;
    assert.equal(supervisor.state, RuntimeState.STOPPING);
    assert.equal((await readManifest(config)).state, RuntimeState.STOPPING);
    releaseStop();
    assert.equal((await stopPromise).state, RuntimeState.STOPPED);
  } finally {
    releaseStop?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("external stop waits for the whole supervisor shutdown budget", async () => {
  const { root, config } = await tempConfig();
  const delayedExit = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80)); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", delayedExit], { stdio: "ignore" });
  config.timeouts.stopGraceMs = 5;
  config.timeouts.stopTimeoutMs = 250;
  try {
    await writeOwner(config, {
      runtimeId: "delayed-stop",
      checkout: config.root,
      profile: config.profile,
      supervisorPid: child.pid,
      state: RuntimeState.READY,
      manifestPath: config.manifestPath,
      services: {},
    });
    const result = await stopCommand(config);
    assert.equal(result.stopped, true);
    assert.equal(result.state, RuntimeState.STOPPED);
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("reload persists reloading state before child restart begins", async () => {
  const { root, config } = await tempConfig();
  let releaseStop;
  let stopStarted;
  const stopGate = new Promise((resolveStop) => {
    releaseStop = resolveStop;
  });
  const stopStartedPromise = new Promise((resolveStarted) => {
    stopStarted = resolveStarted;
  });
  try {
    const supervisor = createSupervisor(config, {
      serviceSpecs: [{ id: "api" }],
      preflightFn: async () => {},
      hooks: {
        watch: false,
        startService: async () => ({ id: "api", pid: process.pid + 1, exited: false, logPath: "api.log" }),
        waitReady: async () => {},
        stopService: async () => {
          stopStarted();
          await stopGate;
        },
      },
    });
    await supervisor.start();
    const reloadPromise = supervisor.reload(["api"]);
    await stopStartedPromise;
    assert.equal(supervisor.state, RuntimeState.RELOADING);
    assert.equal((await readManifest(config)).state, RuntimeState.RELOADING);
    releaseStop();
    assert.equal((await reloadPromise).state, RuntimeState.READY);
    await supervisor.stop();
  } finally {
    releaseStop?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("required child exit resolves foreground wait with failed cleanup", async () => {
  const { root, config } = await tempConfig();
  const stopped = [];
  try {
    let child;
    const supervisor = createSupervisor(config, {
      serviceSpecs: [{ id: "api" }],
      preflightFn: async () => {},
      hooks: {
        watch: false,
        startService: async () => {
          child = new EventEmitter();
          return { id: "api", pid: process.pid + 1, child, exited: false, exitCode: 1, logPath: "api.log" };
        },
        waitReady: async () => {},
        stopService: async (spec) => stopped.push(spec.id),
      },
    });
    await supervisor.start();
    const wait = supervisor.waitForStop();
    supervisor.running.get("api").exited = true;
    child.emit("exit", 1, null);
    const result = await wait;
    assert.equal(result.state, RuntimeState.FAILED);
    assert.deepEqual(stopped, ["api"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
