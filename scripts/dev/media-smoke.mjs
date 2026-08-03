#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import { createMediaObservabilityProof } from "./media-observability-proof.mjs";

export * from "./media-smoke-core.mjs";
export { createMediaSmokeInitScript } from "./media-smoke-page.mjs";
export { runMediaProof } from "./media-smoke-runner.mjs";
export { createMediaObservabilityProof, MEDIA_OBSERVABILITY_DEFAULTS, proveMediaObservability } from "./media-observability-proof.mjs";

async function main() {
  const manifestPath = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? process.env.CHALK_DEV_RUNTIME_MANIFEST;
  if (!manifestPath) throw new Error("Usage: pnpm exec node scripts/dev/media-smoke.mjs <ready-runtime-manifest.json>");
  const { runMediaProof: prove } = await import("./media-smoke-runner.mjs");
  const report = await prove(manifestPath, { observabilityProof: createMediaObservabilityProof({ env: process.env }) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.result !== "passed") process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
