import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDevConfig } from "./config.mjs";
import { acquireMachineLease, readManifest, writeManifest, writeOwner } from "./ownership.mjs";
import { confirmReset, stopCommand, runCommand } from "./commands.mjs";
import { createSupervisor } from "./supervisor.mjs";
import { FailureKind, RuntimeState } from "./model.mjs";

async function tempConfig() {
  const root = await mkdtemp(join(tmpdir(), "chalk-dev-test-"));
  const config = resolveDevConfig({ root, cwd: root, requiredTools: [], home: root, allowBusyPorts: Object.keys({ api: 8080, sync: 4100, web: 3070, bff: 3071, postgres: 5432, redis: 6380, grafana: 3000, broker: 8787 }) });
  return { root, config };
}

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
