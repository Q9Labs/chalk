#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LOCAL_BRIDGE_PORTS = [8787, 8080, 8081, 4100];

export function parseConnectedDevices(output) {
  return output
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
}

function runCommand(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function prepareLocalBridge({ command = process.env.ADB || "adb", ports = LOCAL_BRIDGE_PORTS, run = runCommand, log = console } = {}) {
  let devicesOutput;
  try {
    devicesOutput = run(command, ["devices"]);
  } catch {
    log.warn("Mobile bridge: adb is unavailable; Expo can still run on a simulator.");
    return { status: "unavailable", devices: [], ports: [] };
  }

  const devices = parseConnectedDevices(devicesOutput);
  if (devices.length === 0) {
    log.warn("Mobile bridge: no Android device is connected; Expo can still run on a simulator.");
    return { status: "unavailable", devices, ports: [] };
  }

  const failures = [];
  for (const serial of devices) {
    for (const port of ports) {
      try {
        run(command, ["-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`]);
      } catch {
        failures.push(`${serial}: ${port}`);
      }
    }
  }

  if (failures.length > 0) {
    log.error(`Mobile bridge: could not reverse ${failures.join(", ")}.`);
    return { status: "failed", devices, ports: [...ports], failures };
  }

  log.info(`Mobile bridge ready for ${devices.length} Android device(s) on ports ${ports.join(", ")}.`);
  return { status: "ready", devices, ports: [...ports] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = prepareLocalBridge();
  process.exitCode = result.status === "failed" ? 1 : 0;
}
