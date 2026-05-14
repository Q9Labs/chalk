#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sdkCoreDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(sdkCoreDir, "..", "..");
const openApiSpecPath = path.resolve(repoRoot, "apps/api/openapi.yaml");
const outputDir = path.resolve(sdkCoreDir, "openapi-generated");
const outputPath = path.resolve(outputDir, "effect-httpclient.effect4.ts");

const generatorArgs = [
  "dlx",
  "--package",
  "@effect/openapi-generator@4.0.0-beta.48",
  "--package",
  "swagger2openapi@7.0.8",
  "--package",
  "effect@4.0.0-beta.48",
  "--package",
  "@effect/platform-node@4.0.0-beta.48",
  "openapigen",
  "--spec",
  openApiSpecPath,
  "--format",
  "httpclient",
  "--name",
  "ChalkApi",
];

try {
  const generated = execFileSync("pnpm", generatorArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN ?? "unused",
    },
  });

  mkdirSync(outputDir, { recursive: true });

  const header = `/* eslint-disable */
/**
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Command: pnpm --dir packages/sdk-core run generate:effect-httpclient
 * Source: apps/api/openapi.yaml
 * Generator: @effect/openapi-generator@4.0.0-beta.48 (Effect v4 beta)
 *
 * Note: sdk-core runtime is currently Effect v3. This file is intentionally
 * kept outside src/ so it does not affect the current build pipeline.
 */

`;

  writeFileSync(outputPath, `${header}${generated}`);
  console.log(`Generated ${path.relative(repoRoot, outputPath)}`);
} catch (error) {
  console.error("Failed to generate Effect HTTP client from OpenAPI.");
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exit(1);
}
