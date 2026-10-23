import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

let activeTool;
let metro;
let interrupted;
let ownedDevice;
let simulatorReceipt;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted ??= signal;
    activeTool?.kill(signal);
    metro?.kill(signal);
  });

async function run(command, commandArgs, options = {}) {
  if (interrupted) throw new Error(`received ${interrupted}`);
  const child = spawn(command, commandArgs, { cwd: mobile, stdio: "inherit", ...options });
  activeTool = child;
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      activeTool = undefined;
      if (interrupted || code !== 0) reject(new Error(`${command} ${commandArgs.join(" ")} exited with ${interrupted ?? code ?? signal}`));
      else resolve(output);
    });
  });
}

async function simulator() {
  if (args.length !== 2 || !["--device", "-d"].includes(args[0])) throw new Error("a slot iOS run takes only --device <udid or name>, so each slot drives its own simulator");
  const { devices } = JSON.parse(await run("xcrun", ["simctl", "list", "devices", "available", "-j"], { stdio: ["ignore", "pipe", "inherit"] }));
  const matches = Object.values(devices)
    .flat()
    .filter((device) => device.udid === args[1] || device.name === args[1]);
  if (matches.length !== 1) throw new Error(`expected one available simulator named or identified by ${args[1]}, found ${matches.length}`);
  return matches[0];
}

async function waitForMetro(metro) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error(`received ${interrupted}`);
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

try {
  const device = await simulator();
  if (!["Booted", "Shutdown"].includes(device.state)) throw new Error(`simulator ${device.udid} is ${device.state}; wait for it to settle before launching`);
  if (device.state === "Shutdown") {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device.udid)) throw new Error(`invalid simulator UDID: ${device.udid}`);
    if (process.env.CHALK_REMOTE_RESOURCE_DIR) {
      mkdirSync(process.env.CHALK_REMOTE_RESOURCE_DIR, { recursive: true });
      const receipt = path.join(process.env.CHALK_REMOTE_RESOURCE_DIR, `simulator-${device.udid}`);
      // Record the boot intent first: SIGKILL can land immediately after simctl boots the device.
      writeFileSync(receipt, `${device.udid}\n`, { flag: "wx" });
      simulatorReceipt = receipt;
    }
    ownedDevice = device.udid;
  }
  await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
  const lock = (file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined);
  const podfileLock = lock(path.join(ios, "Podfile.lock"));
  if (!podfileLock || podfileLock !== lock(path.join(ios, "Pods", "Manifest.lock"))) await run("pod", ["install"], { cwd: ios });
  metro = spawn("expo", ["start", "--port", port], { cwd: mobile, stdio: "inherit" });
  const metroExit = new Promise((resolve, reject) => {
    metro.once("error", reject);
    metro.once("exit", (code) => resolve(code));
  });
  // Keep an early spawn failure handled while the native build is still running.
  metroExit.catch(() => {});
  // Slots run headless without a signing identity. 15.1 is the Podfile's platform; the iOS 27 SDK
  // rejects pods that still declare 12.4 or 13.4.
  const derivedData = path.join(ios, "build");
  await run("xcodebuild", ["-quiet", "-workspace", "Chalk.xcworkspace", "-scheme", "Chalk", "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", `id=${device.udid}`, "-derivedDataPath", derivedData, "CODE_SIGNING_ALLOWED=NO", "IPHONEOS_DEPLOYMENT_TARGET=15.1", "build"], {
    cwd: ios,
  });
  const app = path.join(derivedData, "Build", "Products", "Debug-iphonesimulator", "Chalk.app");
  const bundleId = (await run("plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(app, "Info.plist")], { stdio: ["ignore", "pipe", "inherit"] })).trim();
  await waitForMetro(metro);
  await run("xcrun", ["simctl", "install", device.udid, app]);
  spawnSync("xcrun", ["simctl", "terminate", device.udid, bundleId], { stdio: "ignore" }); // Fails harmlessly when the app is not running.
  await run("xcrun", ["simctl", "launch", device.udid, bundleId, "-RCT_jsLocation", `127.0.0.1:${port}`]);
  console.log(`[ios] ${bundleId} on ${device.name} loads from Metro on 127.0.0.1:${port}`);
  process.exitCode = (await metroExit) ?? 1;
} catch (error) {
  console.error(`[ios] ${error.message}`);
  process.exitCode = 1;
} finally {
  if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  metro?.kill(interrupted ?? "SIGTERM");
  if (ownedDevice) {
    try {
      const result = spawnSync("xcrun", ["simctl", "shutdown", ownedDevice], { stdio: "inherit", timeout: 30_000 });
      if (result.status !== 0) throw new Error(`simulator ${ownedDevice} shutdown exited with ${result.status ?? result.error ?? result.signal}`);
      if (simulatorReceipt) unlinkSync(simulatorReceipt);
    } catch (error) {
      console.error(`[ios] ${error.message}; retaining simulator receipt for queue cleanup`);
      process.exitCode = 1;
    }
  }
}
