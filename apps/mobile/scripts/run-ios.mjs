import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `pnpm ios` runs this. Outside a shared-Mac slot it is plain `expo run:ios`. A slot moves Metro
// off 8081 (scripts/gates/remote-slot-env.sh), but iOS Debug builds use React Native's prebuilt
// core, which keeps 8081 compiled in, so the slot run launches the app with its own endpoint.
const mobile = fileURLToPath(new URL("../", import.meta.url));
const ios = path.join(mobile, "ios");
const port = process.env.RCT_METRO_PORT;
const args = process.argv.slice(2);

if (!port || port === "8081") {
  const expo = spawnSync("expo", ["run:ios", ...args], { cwd: mobile, stdio: "inherit" });
  process.exit(expo.status ?? 1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: mobile, stdio: "inherit", encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status ?? result.signal}`);
  return result.stdout;
}

function simulator() {
  if (args.length !== 2 || !["--device", "-d"].includes(args[0])) throw new Error("a slot iOS run takes only --device <udid or name>, so each slot drives its own simulator");
  const { devices } = JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "-j"], { stdio: ["ignore", "pipe", "inherit"] }));
  const matches = Object.values(devices)
    .flat()
    .filter((device) => device.udid === args[1] || device.name === args[1]);
  if (matches.length !== 1) throw new Error(`expected one available simulator named or identified by ${args[1]}, found ${matches.length}`);
  return matches[0];
}

async function waitForMetro(metro) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (metro.exitCode !== null) throw new Error(`Metro exited with ${metro.exitCode} before it answered on port ${port}`);
    try {
      if ((await (await fetch(`http://127.0.0.1:${port}/status`)).text()) === "packager-status:running") return;
    } catch {
      // Metro is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Metro did not answer on port ${port} within two minutes`);
}

let metro;
try {
  const device = simulator();
  run("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
  const lock = (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);
  const podfileLock = lock(path.join(ios, "Podfile.lock"));
  if (!podfileLock || podfileLock !== lock(path.join(ios, "Pods", "Manifest.lock"))) run("pod", ["install"], { cwd: ios });
  metro = spawn("expo", ["start", "--port", port], { cwd: mobile, stdio: "inherit" });
  // Slots run headless without a signing identity. 15.1 is the Podfile's platform; the iOS 27 SDK
  // rejects pods that still declare 12.4 or 13.4.
  const derivedData = path.join(ios, "build");
  run("xcodebuild", ["-quiet", "-workspace", "Chalk.xcworkspace", "-scheme", "Chalk", "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", `id=${device.udid}`, "-derivedDataPath", derivedData, "CODE_SIGNING_ALLOWED=NO", "IPHONEOS_DEPLOYMENT_TARGET=15.1", "build"], { cwd: ios });
  const app = path.join(derivedData, "Build", "Products", "Debug-iphonesimulator", "Chalk.app");
  const bundleId = run("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(app, "Info.plist")], { stdio: ["ignore", "pipe", "inherit"] }).trim();
  await waitForMetro(metro);
  run("xcrun", ["simctl", "install", device.udid, app]);
  spawnSync("xcrun", ["simctl", "terminate", device.udid, bundleId], { stdio: "ignore" }); // Fails harmlessly when the app is not running.
  run("xcrun", ["simctl", "launch", device.udid, bundleId, "-RCT_jsLocation", `127.0.0.1:${port}`]);
  console.log(`[ios] ${bundleId} on ${device.name} loads from Metro on 127.0.0.1:${port}`);
} catch (error) {
  console.error(`[ios] ${error.message}`);
  metro?.kill();
  process.exit(1);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => metro.kill(signal));
metro.on("exit", (code) => process.exit(code ?? 1));
