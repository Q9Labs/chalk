import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
import { resolveDevConfig } from "./config.mjs";
import { spawnCommand, killTree } from "../lib/platform.mjs";

const config = resolveDevConfig({ env: {} });

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
