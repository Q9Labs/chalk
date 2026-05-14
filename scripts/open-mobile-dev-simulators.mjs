#!/usr/bin/env node

/**
 * Chalk mobile simulator launcher.
 *
 * Checklist before relying on this script:
 * - Confirm `apps/mobile/.env.local` points at the API/WS environment you want.
 * - Keep the iPhone/iPad simulator names below aligned with `xcrun simctl list devices available`.
 * - Keep the Android AVD name below aligned with `emulator -list-avds`.
 * - This script intentionally reuses `apps/mobile/scripts/start-ios-sim-dev-client.mjs`
 *   for Expo dev-server startup plus the iOS localhost<->LAN relay.
 *
 * If launches ever stop feeling "one command":
 * - Check `scratchpad/mobile-simulators-helper.log` for Expo/relay failures.
 * - Check `scratchpad/mobile-simulators-android.log` for emulator boot failures.
 * - Kill stale helper processes with `pkill -f start-ios-sim-dev-client.mjs` and rerun.
 * - Re-run after major network changes because the LAN IP baked into the deep link can drift.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const repoRoot = new URL("..", import.meta.url);
const scratchpadDir = path.join(repoRoot.pathname, "scratchpad");
const helperLogPath = path.join(scratchpadDir, "mobile-simulators-helper.log");
const androidLogPath = path.join(scratchpadDir, "mobile-simulators-android.log");
const iPhoneName = "iPhone 17 Pro";
const iPadName = "iPad Pro 13-inch (M5)";
const androidAvdName = "Chalk-Pixel-9";
const chalkBundleId = "ai.q9labs.chalk.mobile";
const helperScriptRelativePath = "apps/mobile/scripts/start-ios-sim-dev-client.mjs";
const expoPort = 8088;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureScratchpad() {
  fs.mkdirSync(scratchpadDir, { recursive: true });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot.pathname,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function tryRun(command, args, options = {}) {
  try {
    return run(command, args, options);
  } catch {
    return "";
  }
}

function getLanIp() {
  const interfaces = os.networkInterfaces();
  const preferred = ["en0", "en1"];

  for (const name of preferred) {
    for (const entry of interfaces[name] ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  throw new Error("Could not determine a LAN IPv4 address for the simulator/dev-client bridge.");
}

function getIosDevices() {
  const raw = run("xcrun", ["simctl", "list", "devices", "--json"]);
  const parsed = JSON.parse(raw);
  return Object.values(parsed.devices ?? {}).flatMap((entries) => entries ?? []);
}

function findIosDeviceByName(name) {
  const match = getIosDevices().find((device) => device.isAvailable && device.name === name);
  if (!match?.udid) {
    throw new Error(`Could not find available iOS simulator named "${name}".`);
  }
  return match.udid;
}

function bootIosDevice(name) {
  const udid = findIosDeviceByName(name);
  const state = tryRun("xcrun", ["simctl", "list", "devices", udid]);
  if (!state.includes("(Booted)")) {
    tryRun("open", ["-a", "Simulator"]);
    tryRun("xcrun", ["simctl", "boot", udid]);
  }
  run("xcrun", ["simctl", "bootstatus", udid, "-b"], { stdio: ["ignore", "pipe", "ignore"] });
  return udid;
}

function getBootedAndroidSerial() {
  const output = tryRun("adb", ["devices"]);
  return (
    output
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .find(([serial, state]) => serial.startsWith("emulator-") && state === "device")?.[0] ?? null
  );
}

function startDetached(command, args, logPath, extraEnv = {}) {
  const out = fs.openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd: repoRoot.pathname,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...extraEnv },
  });
  child.unref();
  return child.pid;
}

function ensureHelperProcess() {
  const existing = tryRun("bash", ["-lc", `pgrep -f '${helperScriptRelativePath}' | head -n 1`]);
  if (existing) {
    return Number(existing);
  }

  return startDetached("node", [helperScriptRelativePath], helperLogPath);
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
          response.resume();
          if ((response.statusCode ?? 500) < 500) {
            resolve();
            return;
          }
          reject(new Error(`HTTP ${response.statusCode ?? "unknown"}`));
        });
        request.on("error", reject);
        request.setTimeout(2_000, () => reject(new Error("timeout")));
      });
      return;
    } catch {
      await sleep(500);
    }
  }

  throw new Error(`Timed out waiting for ${url}.`);
}

async function ensureAndroidEmulator() {
  const existing = getBootedAndroidSerial();
  if (existing) {
    return existing;
  }

  startDetached("emulator", [`@${androidAvdName}`], androidLogPath, {
    ANDROID_EMULATOR_WAIT_TIME_BEFORE_KILL: "1",
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const serial = getBootedAndroidSerial();
    if (serial) {
      const bootComplete = tryRun("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"]);
      if (bootComplete.trim() === "1") {
        return serial;
      }
    }
    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for Android emulator "${androidAvdName}" to boot.`);
}

function reverseAndroidPorts(serial) {
  for (const port of ["8080", "8081"]) {
    tryRun("adb", ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`]);
  }
}

function isAndroidChalkForeground(serial) {
  const output = tryRun("adb", ["-s", serial, "shell", "dumpsys", "activity", "activities"]);
  return output.includes(`${chalkBundleId}/.MainActivity`) && output.includes("topResumedActivity");
}

function openIosDevClient(udid, url) {
  tryRun("xcrun", ["simctl", "launch", udid, chalkBundleId]);
  run("xcrun", ["simctl", "openurl", udid, url], { stdio: ["ignore", "pipe", "ignore"] });
}

async function openAndroidDevClient(serial, url) {
  reverseAndroidPorts(serial);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    run("adb", ["-s", serial, "shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", url], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (isAndroidChalkForeground(serial)) {
        return;
      }
      await sleep(500);
    }
  }

  throw new Error("Android emulator opened the intent but Chalk did not stay foregrounded.");
}

async function main() {
  ensureScratchpad();

  const iPhoneUdid = bootIosDevice(iPhoneName);
  const iPadUdid = bootIosDevice(iPadName);
  const androidSerial = await ensureAndroidEmulator();
  const helperPid = ensureHelperProcess();

  await waitForHttp(`http://127.0.0.1:${expoPort}/`, 60_000);

  const devClientUrl = `exp+chalk-mobile://expo-development-client/?url=${encodeURIComponent(`http://${getLanIp()}:${expoPort}`)}`;

  openIosDevClient(iPhoneUdid, devClientUrl);
  openIosDevClient(iPadUdid, devClientUrl);
  await openAndroidDevClient(androidSerial, devClientUrl);

  console.log(`Metro helper pid: ${helperPid}`);
  console.log(`iPhone booted: ${iPhoneName} (${iPhoneUdid})`);
  console.log(`iPad booted: ${iPadName} (${iPadUdid})`);
  console.log(`Android booted: ${androidAvdName} (${androidSerial})`);
  console.log(`Dev client URL: ${devClientUrl}`);
  console.log(`Helper log: ${helperLogPath}`);
  console.log(`Android log: ${androidLogPath}`);
}

await main();
