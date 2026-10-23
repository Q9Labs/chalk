import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;

// A copy of the launcher in a scratch app, with recording stand-ins for the Apple tools and Expo.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "chalk-run-ios-"));
  const mobile = path.join(root, "apps", "mobile");
  const bin = path.join(root, "bin");
  const calls = path.join(root, "calls.log");
  const launched = path.join(root, "launched");
  for (const directory of [path.join(mobile, "scripts"), path.join(mobile, "ios"), bin]) mkdirSync(directory, { recursive: true });
  cpSync(fileURLToPath(new URL("./run-ios.mjs", import.meta.url)), path.join(mobile, "scripts", "run-ios.mjs"));
  const tool = (name, body) => {
    writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nconst fs = require("fs");\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name)} + " " + args.join(" ") + "\\n");\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  tool(
    "xcrun",
    `
if (args[1] === "list") console.log(JSON.stringify({ devices: { "iOS-27-0": [{ udid: "SLOT-UDID", name: "lane-slot-90" }, { udid: "OTHER-UDID", name: "lane-slot-91" }] } }));
if (args[1] === "launch") fs.writeFileSync(${JSON.stringify(launched)}, "");`,
  );
  tool(
    "xcodebuild",
    `
const app = require("path").join(args[args.indexOf("-derivedDataPath") + 1], "Build/Products/Debug-iphonesimulator/Chalk.app");
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(app + "/Info.plist", "");`,
  );
  tool("plutil", `console.log("ai.q9labs.chalk.mobile");`);
  tool("pod", "");
  tool(
    "expo",
    `
if (args[0] === "start") {
  require("http").createServer((request, response) => response.end("packager-status:running"))
    .listen(Number(args[2]), "127.0.0.1", () => fs.appendFileSync(${JSON.stringify(calls)}, "metro answering\\n"));
  setInterval(() => fs.existsSync(${JSON.stringify(launched)}) && process.exit(0), 50);
}`,
  );
  const launch = (env) =>
    spawnSync(process.execPath, [path.join(mobile, "scripts", "run-ios.mjs"), "--device", "lane-slot-90"], {
      env: { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
      timeout: 30000,
    });
  return { root, launch, calls: () => readFileSync(calls, "utf8").trim().split("\n") };
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
    assert.equal(log[launched], `xcrun simctl launch SLOT-UDID ai.q9labs.chalk.mobile -RCT_jsLocation 127.0.0.1:${port}`);
    assert.ok(log.indexOf("metro answering") < launched, log.join("\n"));
    assert.ok(log.includes(`expo start --port ${port}`), log.join("\n"));
    assert.ok(!log.some((line) => line.startsWith("expo run:ios")), "a slot run must not let Expo launch the app against 8081");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outside a slot, pnpm ios stays plain expo run:ios", () => {
  const { root, launch, calls } = fixture();
  try {
    const { RCT_METRO_PORT: _slotPort, ...env } = process.env;
    const result = launch(env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(calls(), ["expo run:ios --device lane-slot-90"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
