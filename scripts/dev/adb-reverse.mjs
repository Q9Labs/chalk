#!/usr/bin/env node
// Forwards the API and Metro ports of every attached Android device to this machine. Does nothing without adb or a device.
import { execFileSync } from "node:child_process";
import ports from "./ports.json" with { type: "json" };

function adb(...args) {
  return execFileSync("adb", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function attachedDevices() {
  return adb("devices")
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter(([, state]) => state === "device")
    .map(([serial]) => serial);
}

try {
  adb("version");
} catch {
  process.exit(0);
}
for (const serial of attachedDevices()) {
  for (const port of [ports.api, ports.metro]) adb("-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`);
}
