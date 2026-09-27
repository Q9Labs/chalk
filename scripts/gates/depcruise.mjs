#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const result = spawnSync("pnpm", ["exec", "depcruise", "--config", ".dependency-cruiser.cjs", "--output-type", "json", "."], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (result.error) {
  console.error(`Dependency Cruiser could not start: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(result.stderr || result.stdout.slice(0, 5000) || "Dependency Cruiser failed");
  process.exit(result.status ?? 1);
}

try {
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report.modules) || !report.modules.some((module) => typeof module.source === "string" && /\.tsx?$/.test(module.source))) {
    throw new Error("Dependency Cruiser did not analyze TypeScript modules");
  }
  console.log(`Dependency Cruiser checked ${report.modules.length} modules, including TypeScript`);
} catch (error) {
  console.error(`Dependency Cruiser returned an invalid report: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
