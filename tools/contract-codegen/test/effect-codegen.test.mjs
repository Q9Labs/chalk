// @ts-check

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const openApiPath = resolve(repositoryRoot, "contract/generated/openapi.json");
const schemasEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/effect-schemas.mjs");
const httpApiEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/effect-http-api.mjs");
const generatedSchemasPath = resolve(repositoryRoot, "sdks/typescript/client/src/generated/schemas.ts");
const generatedHttpApiPath = resolve(repositoryRoot, "sdks/typescript/client/src/generated/http-api.ts");
const formatterPath = resolve(repositoryRoot, "node_modules/.bin/oxfmt");

describe("Effect HTTP API generation", () => {
  it("regenerates byte-identical Effect schema and HTTP API goldens", async () => {
    await withTemporaryDirectory(async (directory) => {
      const schemasPath = resolve(directory, "schemas.ts");
      const httpApiPath = resolve(directory, "http-api.ts");

      await Promise.all([emit(schemasEmitter, "CODEGEN_EFFECT_OUTPUT_PATH", schemasPath, openApiPath), emit(httpApiEmitter, "CODEGEN_HTTP_API_OUTPUT_PATH", httpApiPath, openApiPath)]);
      await format(schemasPath, httpApiPath);

      await expect(readFile(schemasPath, "utf8")).resolves.toBe(await readFile(generatedSchemasPath, "utf8"));
      await expect(readFile(httpApiPath, "utf8")).resolves.toBe(await readFile(generatedHttpApiPath, "utf8"));
    });
  });

  it("generates constrained required and optional request header schemas", async () => {
    await withTemporaryDirectory(async (directory) => {
      const inputPath = resolve(directory, "openapi.json");
      const schemasPath = resolve(directory, "schemas.ts");
      const httpApiPath = resolve(directory, "http-api.ts");
      await writeFile(inputPath, JSON.stringify(optionalHeaderFixture()));

      await Promise.all([emit(schemasEmitter, "CODEGEN_EFFECT_OUTPUT_PATH", schemasPath, inputPath), emit(httpApiEmitter, "CODEGEN_HTTP_API_OUTPUT_PATH", httpApiPath, inputPath)]);
      await format(schemasPath, httpApiPath);

      await expect(readFile(schemasPath, "utf8")).resolves.toContain(`export const CreateWidgetRequestHeadersSchema = Schema.Struct({
  "Idempotency-Key": Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128), Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$"))),
  "X-Trace-Id": Schema.optional(Schema.String.check(Schema.isMinLength(3))),
});`);
      await expect(readFile(httpApiPath, "utf8")).resolves.toContain("headers: S.CreateWidgetRequestHeadersSchema");
    });
  });

  it("exposes required Idempotency-Key headers on all lifecycle operations", async () => {
    const schemas = await readFile(generatedSchemasPath, "utf8");
    const httpApi = await readFile(generatedHttpApiPath, "utf8");

    for (const operationName of ["CreateRoomSession", "EndRoomSession", "AdmitSessionParticipant", "RemoveSessionParticipant"]) {
      expect(schemas).toContain(`export const ${operationName}RequestHeadersSchema = Schema.Struct({
  "Idempotency-Key": Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128), Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$"))),
});`);
      expect(httpApi).toContain(`headers: S.${operationName}RequestHeadersSchema`);
    }
  });
});

function optionalHeaderFixture() {
  return {
    openapi: "3.1.0",
    info: { title: "Header fixture", version: "1.0.0" },
    paths: {
      "/widgets": {
        post: {
          operationId: "createWidget",
          parameters: [
            {
              in: "header",
              name: "Idempotency-Key",
              required: true,
              schema: { maxLength: 128, minLength: 16, pattern: "^[A-Za-z0-9_-]+$", type: "string" },
            },
            {
              in: "header",
              name: "X-Trace-Id",
              schema: { minLength: 3, type: "string" },
            },
          ],
          responses: { 201: { description: "Created" } },
        },
      },
    },
  };
}

/**
 * @param {string} emitter
 * @param {string} outputVariable
 * @param {string} outputPath
 * @param {string} inputPath
 */
async function emit(emitter, outputVariable, outputPath, inputPath) {
  await new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [emitter],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CODEGEN_OPENAPI_PATH: inputPath,
          [outputVariable]: outputPath,
        },
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`Emitter failed: ${stderr || error.message}`));
          return;
        }
        resolvePromise(undefined);
      },
    );
  });
}

/**
 * @param {...string} paths
 */
async function format(...paths) {
  await new Promise((resolvePromise, reject) => {
    execFile(formatterPath, ["--write", ...paths], { cwd: repositoryRoot }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Formatting failed: ${stderr || error.message}`));
        return;
      }
      resolvePromise(undefined);
    });
  });
}

/**
 * @param {(directory: string) => Promise<void>} action
 */
async function withTemporaryDirectory(action) {
  const directory = await mkdtemp(resolve(tmpdir(), "chalk-effect-codegen-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
