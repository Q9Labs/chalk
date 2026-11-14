#!/usr/bin/env node
// Writes the OpenAPI document, the TypeScript SDK files and the Sync contract files.
//
//   sdk.mjs generate   writes them into the repository
//   sdk.mjs check      writes them into a temporary folder and fails when any differs from the repository
//
// Both modes run the same steps; only the output root differs.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repositoryRoot } from "../lib/repository.mjs";

const clientGenerated = "sdks/typescript/client/src/generated";
const openapi = "contract/generated/openapi.json";
const openapiTypes = `${clientGenerated}/openapi-types.d.ts`;

// Each emitter writes the files that its environment variables name, relative to the output root.
const emitters = [
  { script: "effect-schemas", outputs: { CODEGEN_EFFECT_OUTPUT_PATH: `${clientGenerated}/schemas.ts` } },
  { script: "effect-http-api", outputs: { CODEGEN_HTTP_API_OUTPUT_PATH: `${clientGenerated}/http-api.ts`, CODEGEN_PUBLIC_HTTP_API_OUTPUT_PATH: `${clientGenerated}/public-http-api.ts` } },
  { script: "sync-typescript", outputs: { CODEGEN_SYNC_TYPESCRIPT_OUTPUT_PATH: `${clientGenerated}/sync.ts` } },
  { script: "sync-elixir", outputs: { CODEGEN_SYNC_ELIXIR_OUTPUT_PATH: "apps/sync/lib/chalk_sync/contract/generated.ex" } },
  { script: "whiteboard-typescript", outputs: { CODEGEN_WHITEBOARD_TYPESCRIPT_OUTPUT_PATH: `${clientGenerated}/whiteboard-v1.ts`, CODEGEN_WHITEBOARD_WIRE_LIMITS_OUTPUT_PATH: "packages/whiteboard/src/collab/wire-limits.ts" } },
  { script: "whiteboard-elixir", outputs: { CODEGEN_WHITEBOARD_ELIXIR_OUTPUT_PATH: "apps/sync/lib/chalk_sync/contract/generated_whiteboard_v1.ex" } },
];

const formatted = [openapi, openapiTypes, ...emitters.flatMap((emitter) => Object.values(emitter.outputs)).filter((file) => file.endsWith(".ts"))];
const outputs = [...formatted, ...emitters.flatMap((emitter) => Object.values(emitter.outputs)).filter((file) => file.endsWith(".ex"))];

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repositoryRoot, stdio: ["ignore", "inherit", "inherit"], ...options });
}

function writeAll(root) {
  const at = (file) => join(root, file);
  mkdirSync(dirname(at(openapi)), { recursive: true });
  const document = execFileSync(process.env.GO ?? "go", ["run", "./cmd/codegen"], { cwd: join(repositoryRoot, "apps/api"), stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 28 });
  writeFileSync(at(openapi), document);
  run("pnpm", ["exec", "oxfmt", "--write", at(openapi)]);
  for (const { script, outputs: files } of emitters) {
    const env = { ...process.env, CODEGEN_OPENAPI_PATH: at(openapi), ...Object.fromEntries(Object.entries(files).map(([name, file]) => [name, at(file)])) };
    run("node", [`tools/contract-fixture-proof/src/emitters/${script}.mjs`], { env });
  }
  run("pnpm", ["exec", "openapi-typescript", at(openapi), "--output", at(openapiTypes)]);
  run("pnpm", ["exec", "oxfmt", "--write", ...formatted.slice(1).map(at)]);
}

const mode = process.argv[2];
if (mode === "generate") {
  writeAll(repositoryRoot);
} else if (mode === "check") {
  const scratch = mkdtempSync(join(tmpdir(), "chalk-sdk-"));
  try {
    writeAll(scratch);
    const stale = outputs.filter((file) => readFileSync(join(repositoryRoot, file), "utf8") !== readFileSync(join(scratch, file), "utf8"));
    for (const file of stale) {
      try {
        execFileSync("diff", ["-u", join(repositoryRoot, file), join(scratch, file)], { stdio: ["ignore", "inherit", "inherit"] });
      } catch {
        // diff exits 1 on a difference, which is the output wanted here.
      }
    }
    if (stale.length > 0) {
      console.error(`Stale generated files: ${stale.join(", ")}. Run: pnpm run generate:sdk`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  console.error("usage: sdk.mjs generate|check");
  process.exitCode = 2;
}
