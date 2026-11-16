#!/usr/bin/env node
// Runs the Android Gradle wrapper from apps/mobile/android: gradlew.bat on Windows, ./gradlew elsewhere.
//
//   node scripts/gradle.mjs assembleRelease
import path from "node:path";
import { isWindows, runCommand } from "../../../scripts/lib/platform.mjs";

const androidDirectory = path.resolve(import.meta.dirname, "../android");
const wrapper = path.join(androidDirectory, isWindows ? "gradlew.bat" : "gradlew");
process.exit(runCommand(wrapper, process.argv.slice(2), { cwd: androidDirectory }));
