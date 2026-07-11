// @ts-check
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ClientFrameSchema, ServerFrameSchema, SyncCloseCodes, SyncCorrelationFieldsSchema, SyncProtocolMetadata } from "../../../sdks/typescript/client/src/generated/sync.ts";
import { loadSyncContract } from "../src/emitters/sync-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const schemaPath = resolve(repositoryRoot, "contract/schema/sync-v1.json");
const typeScriptEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/sync-typescript.mjs");
const elixirEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/sync-elixir.mjs");
const generatedTypeScriptPath = resolve(repositoryRoot, "sdks/typescript/client/src/generated/sync.ts");
const generatedElixirPath = resolve(repositoryRoot, "apps/sync/lib/chalk_sync/contract/generated.ex");

describe("sync v1 contract generation", () => {
  it("regenerates byte-identical TypeScript and Elixir golden outputs", async () => {
    await withTemporaryDirectory(async (directory) => {
      const typeScriptOutput = resolve(directory, "sync.ts");
      const elixirOutput = resolve(directory, "generated.ex");

      await emit(typeScriptEmitter, "CODEGEN_SYNC_TYPESCRIPT_OUTPUT_PATH", typeScriptOutput);
      await emit(elixirEmitter, "CODEGEN_SYNC_ELIXIR_OUTPUT_PATH", elixirOutput);

      await expect(readFile(typeScriptOutput, "utf8")).resolves.toBe(await readFile(generatedTypeScriptPath, "utf8"));
      await expect(readFile(elixirOutput, "utf8")).resolves.toBe(await readFile(generatedElixirPath, "utf8"));
    });
  }, 60_000);

  it("fails before emission when the native JSON source violates the v1 version", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v1.json");
      const source = await readFile(schemaPath, "utf8");
      await writeFile(invalidPath, source.replace('"version": 1', '"version": 2'));

      await expect(loadSyncContract(invalidPath)).rejects.toThrow("expected chalk.sync.v1 version 1");
    });
  });

  it("rejects unsupported nested sync field kinds before emission", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v1.json");
      const contract = JSON.parse(await readFile(schemaPath, "utf8"));
      contract.commands[0].commandId.kind = "integar";
      await writeFile(invalidPath, JSON.stringify(contract));

      await expect(loadSyncContract(invalidPath)).rejects.toThrow('unsupported field kind "integar"');
    });
  });

  it("rejects malformed welcome participant fields before emission", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v1.json");
      const contract = JSON.parse(await readFile(schemaPath, "utf8"));
      delete contract.welcome.modes[0].snapshot.participants.items.participantId.kind;
      await writeFile(invalidPath, JSON.stringify(contract));

      await expect(loadSyncContract(invalidPath)).rejects.toThrow("field definitions require a kind");
    });
  });

  it("requires optional correlation fields in the schema source", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v1.json");
      const contract = JSON.parse(await readFile(schemaPath, "utf8"));
      delete contract.correlation;
      await writeFile(invalidPath, JSON.stringify(contract));

      await expect(loadSyncContract(invalidPath)).rejects.toThrow("correlation is required");
    });
  });
});

describe("generated TypeScript sync codecs", () => {
  it("decodes the client union and rejects an invalid cursor or unknown command", () => {
    const correlation = {
      journey_id: "00000000-0000-4000-8000-000000000001",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "chalk=client",
    };

    expect(
      Schema.decodeUnknownSync(ClientFrameSchema)({
        type: "hello",
        protocol: 1,
        token: "token",
        streams: { control: { cursor: 0 } },
        ...correlation,
      }),
    ).toMatchObject({ type: "hello", streams: { control: { cursor: 0 } }, ...correlation });

    expect(Schema.decodeUnknownSync(SyncCorrelationFieldsSchema)(correlation)).toEqual(correlation);

    expect(() =>
      Schema.decodeUnknownSync(ClientFrameSchema)({
        type: "hello",
        protocol: 1,
        token: "token",
        streams: { control: { cursor: -1 } },
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(ClientFrameSchema)({
        type: "ping",
        journey_id: 1,
      }),
    ).toThrow();

    for (const streams of ["bad", { control: "bad" }]) {
      expect(() =>
        Schema.decodeUnknownSync(ClientFrameSchema)({
          type: "hello",
          protocol: 1,
          token: "token",
          streams,
        }),
      ).toThrow();
    }

    expect(() =>
      Schema.decodeUnknownSync(ClientFrameSchema)({
        type: "command",
        command_id: "c-1",
        name: "join",
      }),
    ).toThrow();
  });

  it("decodes snapshot/replay, every ack outcome, control events, errors, and pong", () => {
    const decode = Schema.decodeUnknownSync(ServerFrameSchema);

    expect(
      decode({
        type: "welcome",
        protocol: 1,
        participant_id: "p1",
        mode: "snapshot",
        snapshot: { control_revision: 1, participants: [{ participant_id: "p1", display_name: "Ada", hand_raised: false }] },
        journey_id: "00000000-0000-4000-8000-000000000001",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        tracestate: "chalk=server",
      }),
    ).toMatchObject({ type: "welcome", mode: "snapshot", tracestate: "chalk=server" });

    expect(
      decode({
        type: "welcome",
        protocol: 1,
        participant_id: "p1",
        mode: "replay",
        control_revision: 2,
        events: [
          {
            type: "event",
            stream: "control",
            name: "hand_raised",
            base_revision: 1,
            revision: 2,
            payload: { participant_id: "p1" },
          },
        ],
      }),
    ).toMatchObject({ type: "welcome", mode: "replay" });

    [
      { type: "ack", command_id: "c-1", result: "committed", revision: 2 },
      { type: "ack", command_id: "c-1", result: "duplicate", revision: 2 },
      { type: "ack", command_id: "c-1", result: "rejected", reason: "no_change" },
      { type: "error", code: "protocol_error", message: "unknown_type" },
      { type: "pong" },
    ].forEach((frame) => expect(decode(frame)).toMatchObject(frame));
  });

  it("rejects events that violate revision continuity", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServerFrameSchema)({
        type: "event",
        stream: "control",
        name: "hand_raised",
        base_revision: 5,
        revision: 1,
        payload: { participant_id: "p1" },
      }),
    ).toThrow(/revision must equal base_revision \+ 1/);
  });

  it("exports correlation, phase, continuity, idempotency, close-code, and error-connection metadata", () => {
    expect(SyncProtocolMetadata.correlation).toEqual({
      optionalTopLevelFields: {
        journey_id: { kind: "string", format: "chalk-journey-id" },
        traceparent: { kind: "string", format: "w3c-traceparent" },
        tracestate: { kind: "string", format: "w3c-tracestate" },
      },
      upgradeHeaders: ["x-chalk-journey-id", "traceparent", "tracestate"],
      rule: "propagate_from_first_observed_layer_to_every_downstream_frame",
    });
    expect(SyncProtocolMetadata.phases.map((phase) => phase.id)).toEqual(["awaiting_hello", "joined"]);
    expect(SyncProtocolMetadata.continuity.events.rule).toBe("revision_equals_base_revision_plus_one");
    expect(SyncProtocolMetadata.continuity.snapshotFallback.welcomeMode).toBe("snapshot");
    expect(SyncProtocolMetadata.idempotency.duplicate).toBe("reuses_original_result");
    expect(SyncProtocolMetadata.errorConnection).toBe("open");
    expect(SyncCloseCodes.map((closeCode) => closeCode.code)).toEqual([1002, 1003, 1008, 1011, 1012]);
  });
});

/**
 * @param {string} emitter
 * @param {string} outputVariable
 * @param {string} outputPath
 */
async function emit(emitter, outputVariable, outputPath) {
  await new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [emitter],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CODEGEN_SYNC_CONTRACT_PATH: schemaPath,
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
 * @param {(directory: string) => Promise<void>} action
 */
async function withTemporaryDirectory(action) {
  const directory = await mkdtemp(resolve(tmpdir(), "chalk-sync-codegen-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
