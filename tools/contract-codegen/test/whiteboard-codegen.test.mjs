// @ts-check

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { WhiteboardV1ClientFrameSchema, WhiteboardV1ProtocolLimits, WhiteboardV1ProtocolMetadata, WhiteboardV1ServerFrameSchema } from "../../../sdks/typescript/client/src/generated/whiteboard-v1.ts";
import { loadWhiteboardContract } from "../src/emitters/whiteboard-contract.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const schemaPath = resolve(repositoryRoot, "contract/schema/whiteboard-v1.json");
const typeScriptEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/whiteboard-typescript.mjs");
const elixirEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/whiteboard-elixir.mjs");
const generatedTypeScriptPath = resolve(repositoryRoot, "sdks/typescript/client/src/generated/whiteboard-v1.ts");
const generatedElixirPath = resolve(repositoryRoot, "apps/sync/lib/chalk_sync/contract/generated_whiteboard_v1.ex");

const operationId = "operation-0000000001";
const requestId = "request-00000000001";
const sceneId = "10000000-0000-4000-8000-000000000001";
const participantId = "20000000-0000-4000-8000-000000000002";
const element = {
  id: "rectangle-1",
  type: "rectangle",
  version: 2,
  version_nonce: 4,
  index: "a0",
  is_deleted: false,
  payload: { x: 10, y: 12, width: 40, height: 20 },
};

describe("whiteboard-v1 contract generation", () => {
  it("regenerates byte-identical TypeScript and Elixir outputs", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "chalk-whiteboard-codegen-"));
    try {
      const typeScriptOutput = resolve(directory, "whiteboard-v1.ts");
      const elixirOutput = resolve(directory, "generated_whiteboard_v1.ex");
      await emit(typeScriptEmitter, "CODEGEN_WHITEBOARD_TYPESCRIPT_OUTPUT_PATH", typeScriptOutput);
      await emit(elixirEmitter, "CODEGEN_WHITEBOARD_ELIXIR_OUTPUT_PATH", elixirOutput);
      await execFileAsync(resolve(repositoryRoot, "node_modules/.bin/oxfmt"), ["--write", typeScriptOutput], {
        cwd: repositoryRoot,
      });
      await execFileAsync("mix", ["format", elixirOutput], {
        cwd: resolve(repositoryRoot, "apps/sync"),
      });

      await expect(readFile(typeScriptOutput, "utf8")).resolves.toBe(await readFile(generatedTypeScriptPath, "utf8"));
      await expect(readFile(elixirOutput, "utf8")).resolves.toBe(await readFile(generatedElixirPath, "utf8"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a contract that changes the frozen route", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "chalk-whiteboard-contract-"));
    try {
      const invalidPath = resolve(directory, "whiteboard-v1.json");
      const source = await readFile(schemaPath, "utf8");
      await writeFile(invalidPath, source.replace('"/v1/whiteboard"', '"/v2/whiteboard"'));
      await expect(loadWhiteboardContract(invalidPath)).rejects.toThrow("whiteboard-v1 at /v1/whiteboard");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("strictly decodes bounded client frames and rejects unknown fields", () => {
    const decode = Schema.decodeUnknownSync(WhiteboardV1ClientFrameSchema);
    expect(
      decode({
        type: "submit_update",
        operation_id: operationId,
        scene_id: sceneId,
        sync_all: false,
        elements: [element],
      }),
    ).toMatchObject({ type: "submit_update", scene_id: sceneId });

    expect(() =>
      decode({
        type: "clear",
        operation_id: operationId,
        scene_id: sceneId,
        accidental: true,
      }),
    ).toThrow();

    expect(() =>
      decode({
        type: "submit_update",
        operation_id: operationId,
        scene_id: sceneId,
        sync_all: false,
        elements: Array.from({ length: WhiteboardV1ProtocolLimits.elementBatchMaxItems + 1 }, () => element),
      }),
    ).toThrow();
  });

  it("validates fixed-revision snapshot pages and commit receipts", () => {
    const decode = Schema.decodeUnknownSync(WhiteboardV1ServerFrameSchema);
    expect(
      decode({
        type: "snapshot_page",
        request_id: requestId,
        scene_id: sceneId,
        revision: "42",
        page: 0,
        page_count: 1,
        elements: [element],
        app_state: { view_background_color: "#ffffff" },
      }),
    ).toMatchObject({ type: "snapshot_page", revision: "42" });

    expect(
      decode({
        type: "welcome",
        protocol: "whiteboard-v1",
        participant_session_id: participantId,
        participant_session_generation: 1,
        capabilities: ["drawWhiteboard", "manageWhiteboard"],
        participant_capabilities: ["drawWhiteboard"],
        scene_id: sceneId,
        revision: "42",
        can_draw: true,
      }),
    ).toMatchObject({ type: "welcome", scene_id: sceneId });

    expect(
      decode({
        type: "commit",
        operation_id: operationId,
        outcome: "duplicate",
        scene_id: sceneId,
        revision: "42",
      }),
    ).toMatchObject({ outcome: "duplicate" });
  });

  it("publishes the independent transport and strict recovery bounds", () => {
    expect(WhiteboardV1ProtocolMetadata.protocol).toEqual({
      name: "whiteboard-v1",
      route: "/v1/whiteboard",
      transport: "websocket-json-text",
    });
    expect(WhiteboardV1ProtocolLimits.pendingOperationMaxItems).toBe(128);
    expect(WhiteboardV1ProtocolLimits.snapshotMaxPages).toBe(128);
    expect(WhiteboardV1ProtocolMetadata.persistence).toMatchObject({
      clearStartsNewSceneEpoch: true,
      fullSyncDeletesAbsentElements: false,
      operationReceipts: true,
    });
  });
});

/**
 * @param {string} emitter
 * @param {string} outputVariable
 * @param {string} outputPath
 */
async function emit(emitter, outputVariable, outputPath) {
  await execFileAsync(process.execPath, [emitter], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CODEGEN_WHITEBOARD_CONTRACT_PATH: schemaPath,
      [outputVariable]: outputPath,
    },
  });
}
