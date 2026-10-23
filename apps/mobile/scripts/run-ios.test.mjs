import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;

// A copy of the launcher in a scratch app, with recording stand-ins for the Apple tools and Expo.
const ownedUDID = "11111111-1111-4111-8111-111111111111";
const otherUDID = "22222222-2222-4222-8222-222222222222";

function fixture({ state = "Shutdown", failure = false, signal } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "chalk-run-ios-"));
  const mobile = path.join(root, "apps", "mobile");
  const bin = path.join(root, "bin");
  const calls = path.join(root, "calls.log");
  const launched = path.join(root, "launched");
  const devices = path.join(root, "devices.json");
  const resources = path.join(root, "resources");
  mkdirSync(resources);
  writeFileSync(
    devices,
    JSON.stringify({
      devices: {
        "iOS-27-0": [
          { udid: ownedUDID, name: "lane-slot-90", state },
          { udid: otherUDID, name: "lane-slot-91", state: "Booted" },
        ],
      },
    }),
  );
  for (const directory of [path.join(mobile, "scripts"), path.join(mobile, "ios"), bin]) mkdirSync(directory, { recursive: true });
  cpSync(fileURLToPath(new URL("./run-ios.mjs", import.meta.url)), path.join(mobile, "scripts", "run-ios.mjs"));
  const tool = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nconst fs = require("fs");\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name)} + " " + args.join(" ") + "\\n");\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  tool(
    "xcrun",
    `
const devicesPath = ${JSON.stringify(devices)};
const data = JSON.parse(fs.readFileSync(devicesPath));
if (args[1] === "list") console.log(JSON.stringify(data));
if (["bootstatus", "shutdown"].includes(args[1])) {
  data.devices["iOS-27-0"].find(device => device.udid === args[2]).state = args[1] === "shutdown" ? "Shutdown" : "Booted";
  fs.writeFileSync(devicesPath, JSON.stringify(data));
}
if (args[1] === "launch") fs.writeFileSync(${JSON.stringify(launched)}, "");`,
  );
  tool(
    "xcodebuild",
    `
const app = require("path").join(args[args.indexOf("-derivedDataPath") + 1], "Build/Products/Debug-iphonesimulator/Chalk.app");
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(app + "/Info.plist", "");`,
  );
  if (failure) tool("xcodebuild", "process.exit(42);");
  if (signal) tool("xcodebuild", `process.kill(process.ppid, ${JSON.stringify(signal)}); setTimeout(() => process.exit(0), 200);`);
  tool("plutil", `console.log("ai.q9labs.chalk.mobile");`);
  tool("pod", "");
  tool(
    "expo",
    `
if (args[0] === "start") {
  require("http").createServer((request, response) => response.end("packager-status:running"))
    .listen(Number(args[2]), "127.0.0.1", () => fs.appendFileSync(${JSON.stringify(calls)}, "metro answering\\n"));
  setInterval(() => {
    try { process.kill(process.ppid, 0); } catch { process.exit(0); }
    if (process.ppid === 1 || fs.existsSync(${JSON.stringify(launched)})) process.exit(0);
  }, 50);
}`,
  );
  const launch = (env) =>
    spawnSync(process.execPath, [path.join(mobile, "scripts", "run-ios.mjs"), "--device", "lane-slot-90"], {
      env: { ...env, CHALK_REMOTE_RESOURCE_DIR: resources, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
      timeout: 30000,
    });
  return { root, launch, resources, devices: () => JSON.parse(readFileSync(devices, "utf8")).devices["iOS-27-0"], calls: () => readFileSync(calls, "utf8").trim().split("\n") };
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("pnpm ios goes through the slot-aware launcher", () => {
  for (const name of ["ios", "start:ios-sim"]) assert.match(scripts[name], /&& node scripts\/run-ios\.mjs$/);
});

test("a slot iOS run launches the app with its own Metro endpoint once Metro answers", async () => {
  const { root, launch, calls } = fixture();
  try {
    const port = await freePort();
    const result = launch({ ...process.env, RCT_METRO_PORT: String(port) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const log = calls();
    const launched = log.findIndex((line) => line.startsWith("xcrun simctl launch"));
    assert.equal(log[launched], `xcrun simctl launch ${ownedUDID} ai.q9labs.chalk.mobile -RCT_jsLocation 127.0.0.1:${port}`);
    assert.ok(log.indexOf("metro answering") < launched, log.join("\n"));
    assert.ok(log.includes(`expo start --port ${port}`), log.join("\n"));
    assert.ok(!log.some((line) => line.startsWith("expo run:ios")), "a slot run must not let Expo launch the app against 8081");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of [{ name: "normal Metro exit" }, { name: "build failure after boot", failure: true }, { name: "SIGINT during the build", signal: "SIGINT" }, { name: "SIGTERM during the build", signal: "SIGTERM" }]) {
  test(`a slot launcher shuts down its owned simulator on ${scenario.name}`, async () => {
    const fixtureRun = fixture(scenario);
    try {
      const result = fixtureRun.launch({ ...process.env, RCT_METRO_PORT: String(await freePort()) });
      assert.ifError(result.error);
      assert.equal(result.status, scenario.failure ? 1 : scenario.signal === "SIGINT" ? 130 : scenario.signal ? 143 : 0, result.stdout + result.stderr);
      assert.equal(fixtureRun.devices()[0].state, "Shutdown", "launcher leaked the simulator it booted");
      assert.equal(fixtureRun.devices()[1].state, "Booted", "launcher stopped another simulator");
      assert.equal(fixtureRun.calls().filter((line) => line === `xcrun simctl shutdown ${ownedUDID}`).length, 1);
      assert.deepEqual(readdirSync(fixtureRun.resources), [], "successful cleanup must remove the receipt");
    } finally {
      rmSync(fixtureRun.root, { recursive: true, force: true });
    }
  });
}

test("a slot launcher leaves an already-booted simulator alone on failure", async () => {
  const fixtureRun = fixture({ state: "Booted", failure: true });
  try {
    const result = fixtureRun.launch({ ...process.env, RCT_METRO_PORT: String(await freePort()) });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(fixtureRun.devices()[0].state, "Booted");
    assert.ok(!fixtureRun.calls().some((line) => line.startsWith("xcrun simctl shutdown")));
    assert.deepEqual(readdirSync(fixtureRun.resources), [], "pre-existing devices must not acquire cleanup receipts");
  } finally {
    rmSync(fixtureRun.root, { recursive: true, force: true });
  }
});

test("SIGKILL leaves a durable owned-simulator receipt for queue recovery", async () => {
  const fixtureRun = fixture({ signal: "SIGKILL" });
  try {
    const result = fixtureRun.launch({ ...process.env, RCT_METRO_PORT: String(await freePort()) });
    assert.ifError(result.error);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(fixtureRun.devices()[0].state, "Booted");
    assert.equal(readFileSync(path.join(fixtureRun.resources, `simulator-${ownedUDID}`), "utf8"), `${ownedUDID}\n`);
  } finally {
    rmSync(fixtureRun.root, { recursive: true, force: true });
  }
});

for (const port of [undefined, "8081"]) {
  test(`outside a slot (Metro ${port ?? "unset"}), pnpm ios stays plain expo run:ios`, () => {
    const { root, launch, calls } = fixture();
    try {
      const { RCT_METRO_PORT: _slotPort, ...env } = process.env;
      if (port) env.RCT_METRO_PORT = port;
      const result = launch(env);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(calls(), ["expo run:ios --device lane-slot-90"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
