#!/usr/bin/env node
// Forwards the API and Metro ports of every attached Android device to this machine. Does nothing without adb or a device.
import { execCommandSync } from "../lib/platform.mjs";
import { reverseAndroidPorts } from "./android.mjs";

await reverseAndroidPorts({ run: async (command, args) => ({ stdout: execCommandSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }) }) });
