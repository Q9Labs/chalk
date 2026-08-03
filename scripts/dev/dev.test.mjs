import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments, preflight, resolveDevConfig } from "./config.mjs";
import { acquireMachineLease, readManifest, writeManifest, writeOwner } from "./ownership.mjs";
import { confirmReset, stopCommand, runCommand } from "./commands.mjs";
import { runCli } from "./cli.mjs";
import { createLogMux, tailLog, waitForFileReady, waitForHTTPReady } from "./process.mjs";
import { createReloadCoordinator, createSourcePoller, dependencyOrder } from "./reload.mjs";
import { createSupervisor } from "./supervisor.mjs";
import { createResourceManager } from "./chalk-resources.mjs";
import { resolveLocalSfuCredentials } from "./secrets.mjs";
import { generateSigningIdentity, identityPaths } from "./identity.mjs";
import { failure, FailureKind, RuntimeState } from "./model.mjs";

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

test("CLI installs signal cleanup before startup awaits", async () => {
  const { root } = await tempConfig();
  const signalSource = new EventEmitter();
  let releaseStart;
  let started;
  const startEntered = new Promise((resolveStart) => {
    started = resolveStart;
  });
  const startGate = new Promise((resolveStart) => {
    releaseStart = resolveStart;
  });
  let stops = 0;
  let startSettled = false;
  const supervisor = {
    async start() {
      started();
      await startGate;
      startSettled = true;
      return { state: RuntimeState.READY };
    },
    async stop() {
      stops += 1;
      assert.equal(startSettled, true);
      return { state: RuntimeState.STOPPED };
    },
  };
  try {
    const running = runCli(["start"], {
      cwd: root,
      root,
      env: { XDG_STATE_HOME: root },
      create: () => supervisor,
      keepAlive: false,
      signalSource,
      errorOutput: () => {},
    });
    await startEntered;
    assert.equal(signalSource.listenerCount("SIGINT"), 1);
    signalSource.emit("SIGINT");
    assert.equal(stops, 0);
    releaseStart();
    assert.equal((await running).code, 0);
    assert.equal(stops, 1);
  } finally {
    releaseStart?.();
    await rm(root, { recursive: true, force: true });
  }
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
      supervisorExpectedCommand: process.execPath,
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

test("external stop refuses a live PID whose command no longer matches", async () => {
  const { root, config } = await tempConfig();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  let killed = false;
  try {
    await writeOwner(config, {
      runtimeId: "identity-check",
      checkout: config.root,
      profile: config.profile,
      supervisorPid: child.pid,
      supervisorExpectedCommand: "not-the-recorded-supervisor",
      state: RuntimeState.READY,
      manifestPath: config.manifestPath,
      services: {},
    });
    await assert.rejects(stopCommand(config, { hooks: { kill: () => (killed = true) } }), { kind: FailureKind.OWNERSHIP_CONFLICT });
    assert.equal(killed, false);
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("reset reads the owner manifest and refuses another checkout", async () => {
  const { root, config } = await tempConfig();
  const ownerManifestPath = join(root, "owner-runtime", "manifest.json");
  const currentManifestService = { pid: 999, expectedCommand: "current-manifest" };
  const ownerManifestService = { pid: 888, expectedCommand: "owner-manifest" };
  const seen = [];
  try {
    await writeManifest(config, { services: [["current", currentManifestService]] });
    await writeManifest({ ...config, manifestPath: ownerManifestPath }, { services: [["owner", ownerManifestService]] });
    await writeOwner(config, {
      runtimeId: "cross-checkout",
      checkout: "/another/chalk-checkout",
      profile: config.profile,
      supervisorPid: 777,
      supervisorExpectedCommand: "not-live",
      state: RuntimeState.READY,
      manifestPath: ownerManifestPath,
      services: {},
    });
    await assert.rejects(
      runCommand("reset", config, {
        yes: true,
        hooks: {
          validatePid: async (pid, options) => {
            seen.push({ pid, options });
            return pid === ownerManifestService.pid;
          },
          resetResources: async () => {
            throw new Error("must not reset another checkout");
          },
        },
      }),
      { kind: FailureKind.OWNERSHIP_CONFLICT },
    );
    assert.deepEqual(
      seen.map(({ pid }) => pid),
      [777, ownerManifestService.pid],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset confirmation reads an explicit yes/no answer from stdin", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const answer = confirmReset("Reset?", { input, output });
  setImmediate(() => input.end("yes\n"));
  assert.equal(await answer, true);
  await assert.rejects(confirmReset("Reset?", { input: null, output }), { kind: FailureKind.CONFIG, message: /requires --yes/ });
  const nonInteractiveInput = new PassThrough();
  nonInteractiveInput.isTTY = false;
  await assert.rejects(confirmReset("Reset?", { input: nonInteractiveInput, output }), { kind: FailureKind.CONFIG, message: /requires --yes/ });
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

test("reload keeps an optional restart failure degraded while core services recover", async () => {
  const { root, config } = await tempConfig();
  let failMobile = false;
  try {
    const supervisor = createSupervisor(config, {
      serviceSpecs: [{ id: "api" }, { id: "mobile", dependsOn: ["api"], optional: true }],
      preflightFn: async () => {},
      hooks: {
        watch: false,
        startService: async (spec) => ({ id: spec.id, pid: process.pid + 1, exited: false, logPath: `${spec.id}.log` }),
        waitReady: async (spec) => {
          if (spec.id === "mobile" && failMobile) throw failure(FailureKind.READINESS_TIMEOUT, "mobile did not become ready", { stage: "readiness", service: spec.id });
        },
        stopService: async () => {},
      },
    });
    await supervisor.start();
    failMobile = true;
    const degraded = await supervisor.reload(["api"]);
    assert.equal(degraded.state, RuntimeState.DEGRADED);
    assert.equal(degraded.failure, undefined);
    assert.equal(degraded.optionalFailures.mobile.message, "mobile did not become ready");
    assert.equal((await readManifest(config)).state, RuntimeState.DEGRADED);
    failMobile = false;
    const recovered = await supervisor.reload(["mobile"]);
    assert.equal(recovered.state, RuntimeState.READY);
    assert.deepEqual(recovered.optionalFailures, {});
    assert.equal(recovered.failure, undefined);
    assert.equal((await readManifest(config)).state, RuntimeState.READY);
    await supervisor.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reload clears the root failure after the required service recovers", async () => {
  const { root, config } = await tempConfig();
  let failApi = false;
  try {
    const supervisor = createSupervisor(config, {
      serviceSpecs: [{ id: "api" }],
      preflightFn: async () => {},
      hooks: {
        watch: false,
        startService: async () => ({ id: "api", pid: process.pid + 1, exited: false, logPath: "api.log" }),
        waitReady: async (spec) => {
          if (failApi) throw failure(FailureKind.READINESS_TIMEOUT, "api did not become ready", { stage: "readiness", service: spec.id });
        },
        stopService: async () => {},
      },
    });
    await supervisor.start();
    failApi = true;
    await assert.rejects(supervisor.reload(["api"]), { kind: FailureKind.READINESS_TIMEOUT });
    assert.equal(supervisor.state, RuntimeState.RELOAD_FAILED);
    assert.equal((await readManifest(config)).failure.service, "api");
    failApi = false;
    const recovered = await supervisor.reload(["api"]);
    assert.equal(recovered.state, RuntimeState.READY);
    assert.equal(recovered.failure, undefined);
    const manifest = await readManifest(config);
    assert.equal(manifest.state, RuntimeState.READY);
    assert.equal(manifest.failure, undefined);
    await supervisor.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reload recovers missing required dependants after a metadata-free failure", async () => {
  const { root, config } = await tempConfig();
  let failApi = false;
  try {
    const supervisor = createSupervisor(config, {
      serviceSpecs: [{ id: "api" }, { id: "sync", dependsOn: ["api"] }, { id: "sdk-client" }, { id: "web", dependsOn: ["sync", "sdk-client"] }],
      preflightFn: async () => {},
      hooks: {
        watch: false,
        startService: async (spec) => ({ id: spec.id, pid: process.pid + 1, exited: false, logPath: `${spec.id}.log` }),
        waitReady: async (spec) => {
          if (spec.id === "api" && failApi) throw failure(FailureKind.READINESS_TIMEOUT, "api did not become ready", { stage: "readiness" });
        },
        stopService: async () => {},
      },
    });
    await supervisor.start();
    failApi = true;
    await assert.rejects(supervisor.reload(["api"]), { kind: FailureKind.READINESS_TIMEOUT });
    assert.equal(supervisor.state, RuntimeState.RELOAD_FAILED);
    assert.equal((await readManifest(config)).failure.service, undefined);
    assert.equal(supervisor.running.has("sync"), false);
    assert.equal(supervisor.running.has("web"), false);

    failApi = false;
    const recovered = await supervisor.reload(["sdk-client"]);
    assert.equal(recovered.state, RuntimeState.READY);
    assert.equal(recovered.failure, undefined);
    assert.deepEqual(Object.keys(recovered.services), ["api", "sync", "sdk-client", "web"]);
    const manifest = await readManifest(config);
    assert.equal(manifest.state, RuntimeState.READY);
    assert.equal(manifest.failure, undefined);
    await supervisor.stop();
  } finally {
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
