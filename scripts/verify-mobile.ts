#!/usr/bin/env bun
/**
 * Mobile Build Verification Script
 * Checks for common issues that cause mobile crashes
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
let hasErrors = false;

function error(msg: string) {
	console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
	hasErrors = true;
}

function success(msg: string) {
	console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
}

function warn(msg: string) {
	console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`);
}

// Check 1: No reanimated v4 in lockfile
console.log("\nChecking dependencies...");
const lockfilePath = join(ROOT, "bun.lock");
if (existsSync(lockfilePath)) {
	const lockContent = readFileSync(lockfilePath, "utf-8");
	if (lockContent.includes("react-native-reanimated@4")) {
		error("Found react-native-reanimated@4 in lockfile - must use v3.x");
	} else {
		success("No reanimated v4 found in lockfile");
	}
} else {
	warn("No bun.lock found - run bun install first");
}

// Check 2: SDK RN build exists
console.log("\nChecking SDK builds...");
const sdkDistPath = join(ROOT, "packages/sdk-react-native/dist/index.js");
const sdkRnDistPath = join(
	ROOT,
	"packages/sdk-react-native/dist/react-native/index.js",
);

if (existsSync(sdkDistPath)) {
	success("SDK node build exists");
} else {
	error("SDK node build missing - run: cd packages/sdk-react-native && bun run build");
}

if (existsSync(sdkRnDistPath)) {
	success("SDK react-native build exists");
} else {
	error(
		"SDK react-native build missing - run: cd packages/sdk-react-native && bun run build",
	);
}

// Check 3: No node: imports in RN dist
console.log("\nChecking for node: imports in RN dist...");
if (existsSync(sdkRnDistPath)) {
	const rnDistContent = readFileSync(sdkRnDistPath, "utf-8");
	const nodeImports = rnDistContent.match(/["']node:[^"']+["']/g);
	if (nodeImports && nodeImports.length > 0) {
		error(`Found node: imports in RN dist: ${nodeImports.join(", ")}`);
	} else {
		success("No node: imports in RN dist");
	}
}

// Check 4: app.json has correct settings
console.log("\nChecking mobile2 app.json...");
const appJsonPath = join(ROOT, "apps/mobile2/app.json");
if (existsSync(appJsonPath)) {
	const appJson = JSON.parse(readFileSync(appJsonPath, "utf-8"));
	const expo = appJson.expo;

	if (expo.newArchEnabled === false) {
		success("newArchEnabled is false");
	} else {
		error("newArchEnabled must be false in app.json");
	}

	if (expo.jsEngine === "hermes") {
		success("jsEngine is hermes");
	} else {
		error("jsEngine must be hermes in app.json");
	}
} else {
	error("apps/mobile2/app.json not found");
}

// Check 5: SDK package.json has react-native export condition
console.log("\nChecking SDK package.json exports...");
const sdkPkgPath = join(ROOT, "packages/sdk-react-native/package.json");
if (existsSync(sdkPkgPath)) {
	const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, "utf-8"));
	if (sdkPkg.exports?.["."]?.["react-native"]) {
		success("SDK has react-native export condition");
	} else {
		error("SDK missing react-native export condition in package.json");
	}
	if (sdkPkg["react-native"]) {
		success("SDK has top-level react-native field");
	} else {
		error("SDK missing top-level react-native field in package.json");
	}
}

// Summary
console.log("\n" + "=".repeat(50));
if (hasErrors) {
	console.error("\x1b[31mVerification FAILED\x1b[0m - fix errors above");
	process.exit(1);
} else {
	console.log("\x1b[32mVerification PASSED\x1b[0m");
	process.exit(0);
}
