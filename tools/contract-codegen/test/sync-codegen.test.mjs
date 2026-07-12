// @ts-check
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ClientFrameSchema, ServerFrameSchema, SyncCloseCodes, SyncCorrelationFieldsSchema, SyncProtocolMetadata } from "../../../sdks/typescript/client/src/generated/sync.ts";
import { ClientFrameSchema as ClientV2FrameSchema, ServerFrameSchema as ServerV2FrameSchema, SyncProtocolLimits, SyncProtocolMetadata as SyncV2ProtocolMetadata, encodeSyncFrame, encodedSyncFrameBytes } from "../../../sdks/typescript/client/src/generated/sync-v2.ts";
import { loadSyncContract, syncProtocolVersion } from "../src/emitters/sync-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const v1SchemaPath = resolve(repositoryRoot, "contract/schema/sync-v1.json");
const v2SchemaPath = resolve(repositoryRoot, "contract/schema/sync-v2.json");
const typeScriptEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/sync-typescript.mjs");
const elixirEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/sync-elixir.mjs");
const generatedTypeScriptPath = resolve(repositoryRoot, "sdks/typescript/client/src/generated/sync.ts");
const generatedElixirPath = resolve(repositoryRoot, "apps/sync/lib/chalk_sync/contract/generated.ex");
const generatedV2TypeScriptPath = resolve(repositoryRoot, "sdks/typescript/client/src/generated/sync-v2.ts");
const generatedV2ElixirPath = resolve(repositoryRoot, "apps/sync/lib/chalk_sync/contract/generated_v2.ex");
const v2FixturePath = resolve(repositoryRoot, "contract/schema/fixtures/sync-v2/golden-frames.json");
const v2DigestFixturePath = resolve(repositoryRoot, "contract/schema/fixtures/sync-v2/digest-vectors.json");
const v2ParticipantFixturePath = resolve(repositoryRoot, "contract/schema/fixtures/sync-v2/max-participant.json");

/** @typedef {{canonical_json: string, projection: unknown, state_digest: string, state_schema_version: number}} DigestVector */

describe("sync v1 contract generation", () => {
  it("regenerates byte-identical TypeScript and Elixir golden outputs", async () => {
    await withTemporaryDirectory(async (directory) => {
      const typeScriptOutput = resolve(directory, "sync.ts");
      const elixirOutput = resolve(directory, "generated.ex");

      await emit(typeScriptEmitter, "CODEGEN_SYNC_TYPESCRIPT_OUTPUT_PATH", typeScriptOutput, v1SchemaPath, 1);
      await emit(elixirEmitter, "CODEGEN_SYNC_ELIXIR_OUTPUT_PATH", elixirOutput, v1SchemaPath, 1);

      await expect(readFile(typeScriptOutput, "utf8")).resolves.toBe(await readFile(generatedTypeScriptPath, "utf8"));
      await expect(readFile(elixirOutput, "utf8")).resolves.toBe(await readFile(generatedElixirPath, "utf8"));
    });
  }, 60_000);

  it("fails before emission when the native JSON source violates the v1 version", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v1.json");
      const source = await readFile(v1SchemaPath, "utf8");
      await writeFile(invalidPath, source.replace('"version": 1', '"version": 2'));

      await expect(loadSyncContract(invalidPath, 1)).rejects.toThrow("expected chalk.sync.v1 version 1");
    });
  });

  it("rejects unsupported nested sync field kinds before emission", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v1.json");
      const contract = JSON.parse(await readFile(v1SchemaPath, "utf8"));
      contract.commands[0].commandId.kind = "integar";
      await writeFile(invalidPath, JSON.stringify(contract));

      await expect(loadSyncContract(invalidPath, 1)).rejects.toThrow('unsupported field kind "integar"');
    });
  });

  it("rejects malformed welcome participant fields before emission", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v1.json");
      const contract = JSON.parse(await readFile(v1SchemaPath, "utf8"));
      delete contract.welcome.modes[0].snapshot.participants.items.participantId.kind;
      await writeFile(invalidPath, JSON.stringify(contract));

      await expect(loadSyncContract(invalidPath, 1)).rejects.toThrow("field definitions require a kind");
    });
  });

  it("requires optional correlation fields in the schema source", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v1.json");
      const contract = JSON.parse(await readFile(v1SchemaPath, "utf8"));
      delete contract.correlation;
      await writeFile(invalidPath, JSON.stringify(contract));

      await expect(loadSyncContract(invalidPath, 1)).rejects.toThrow("correlation is required");
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

describe("sync v2 contract generation", () => {
  it("requires explicit version selection and regenerates the v2 TypeScript and Elixir goldens", async () => {
    expect(syncProtocolVersion("1")).toBe(1);
    expect(syncProtocolVersion("2")).toBe(2);
    expect(() => syncProtocolVersion("3")).toThrow('expected "1" or "2"');

    await withTemporaryDirectory(async (directory) => {
      const typeScriptOutput = resolve(directory, "sync-v2.ts");
      const elixirOutput = resolve(directory, "generated_v2.ex");

      await emit(typeScriptEmitter, "CODEGEN_SYNC_TYPESCRIPT_OUTPUT_PATH", typeScriptOutput, v2SchemaPath, 2);
      await emit(elixirEmitter, "CODEGEN_SYNC_ELIXIR_OUTPUT_PATH", elixirOutput, v2SchemaPath, 2);

      await expect(readFile(typeScriptOutput, "utf8")).resolves.toBe(await readFile(generatedV2TypeScriptPath, "utf8"));
      await expect(readFile(elixirOutput, "utf8")).resolves.toBe(await readFile(generatedV2ElixirPath, "utf8"));
    });
  }, 60_000);

  it("rejects a v2 source with a non-approved limit before emission", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v2.json");
      const source = await readFile(v2SchemaPath, "utf8");
      await writeFile(invalidPath, source.replace('"tokenBytes": 8192', '"tokenBytes": 8193'));

      await expect(loadSyncContract(invalidPath, 2)).rejects.toThrow("limits.tokenBytes must equal 8192");
    });
  });

  it("decodes and re-encodes every golden v2 frame", async () => {
    const fixtures = /** @type {{client_frames: unknown[], server_frames: unknown[]}} */ (JSON.parse(await readFile(v2FixturePath, "utf8")));
    const decodeClient = Schema.decodeUnknownSync(ClientV2FrameSchema);
    const decodeServer = Schema.decodeUnknownSync(ServerV2FrameSchema);

    fixtures.client_frames.forEach((frame) => {
      expect(encodeSyncFrame(decodeClient(frame))).toBe(JSON.stringify(frame));
    });
    fixtures.server_frames.forEach((frame) => {
      expect(encodeSyncFrame(decodeServer(frame))).toBe(JSON.stringify(frame));
    });
  });

  it("rejects unknown fields, unbounded command IDs, ambiguous origins, and malformed replay pages", async () => {
    const decodeClient = Schema.decodeUnknownSync(ClientV2FrameSchema);
    const decodeServer = Schema.decodeUnknownSync(ServerV2FrameSchema);
    const fixtures = JSON.parse(await readFile(v2FixturePath, "utf8"));

    expect(() =>
      decodeClient({
        type: "command",
        command_id: "short",
        name: "raise_hand",
        payload: {},
      }),
    ).toThrow();

    expect(() =>
      decodeClient({
        type: "hello",
        protocol: 2,
        token: "signed-token",
        streams: { control: { cursor: null } },
        unexpected: true,
      }),
    ).toThrow();

    const event = structuredClone(fixtures.server_frames[2].events[0]);
    event.lifecycle_intent_id = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c25";
    expect(() => decodeServer(event)).toThrow();

    const replayPage = structuredClone(fixtures.server_frames[2]);
    replayPage.first_revision = 5;
    expect(() => decodeServer(replayPage)).toThrow();
  });

  it("requires the delivery acknowledgement's exact control-stream wire shape", () => {
    const decodeClient = Schema.decodeUnknownSync(ClientV2FrameSchema);
    const frame = {
      type: "delivery_ack",
      stream: "control",
      revision: 7,
      state_digest: "a".repeat(64),
    };

    expect(decodeClient(frame)).toEqual(frame);
    expect(() => decodeClient({ ...frame, unexpected: true })).toThrow();
    expect(() => decodeClient({ ...frame, stream: "events" })).toThrow();
    expect(() => decodeClient({ ...frame, revision: 0 })).toThrow();
    expect(() => decodeClient({ ...frame, state_digest: "A".repeat(64) })).toThrow();
  });

  it("requires the recovery acknowledgement's exact recovery wire shape", () => {
    const decodeClient = Schema.decodeUnknownSync(ClientV2FrameSchema);
    const frame = {
      type: "recovery_ack",
      recovery_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22",
      revision: 0,
      state_digest: "a".repeat(64),
    };

    expect(decodeClient(frame)).toEqual(frame);
    expect(() => decodeClient({ ...frame, unexpected: true })).toThrow();
    expect(() => decodeClient({ ...frame, recovery_id: "not-a-uuid" })).toThrow();
    expect(() => decodeClient({ ...frame, revision: -1 })).toThrow();
    expect(() => decodeClient({ ...frame, state_digest: "A".repeat(64) })).toThrow();
  });

  it("keeps approved digest and maximum participant encoding vectors exact", async () => {
    const digestVectors = /** @type {{prefix: string, vectors: DigestVector[]}} */ (JSON.parse(await readFile(v2DigestFixturePath, "utf8")));
    const participantFixture = /** @type {{encoded_bytes: number, participant: unknown, reservation_bytes: number}} */ (JSON.parse(await readFile(v2ParticipantFixturePath, "utf8")));

    digestVectors.vectors.forEach((vector) => {
      expect(JSON.stringify(vector.projection)).toBe(vector.canonical_json);
      const input = Buffer.concat([Buffer.from(digestVectors.prefix, "ascii"), Buffer.from([0]), Buffer.from([0, 0, 0, vector.state_schema_version]), Buffer.from(vector.canonical_json, "utf8")]);
      expect(createHash("sha256").update(input).digest("hex")).toBe(vector.state_digest);
    });

    expect(encodedSyncFrameBytes(participantFixture.participant)).toBe(participantFixture.encoded_bytes);
    expect(participantFixture.encoded_bytes).toBeLessThanOrEqual(participantFixture.reservation_bytes);
    expect(SyncProtocolLimits.decodedInboundFrameBytes).toBe(65_536);
    expect(SyncV2ProtocolMetadata.continuity.replay.maxEvents).toBe(2_048);
  });
});

/**
 * @param {string} emitter
 * @param {string} outputVariable
 * @param {string} outputPath
 * @param {string} schemaPath
 * @param {number} protocolVersion
 */
async function emit(emitter, outputVariable, outputPath, schemaPath, protocolVersion) {
  await new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [emitter],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CODEGEN_SYNC_CONTRACT_PATH: schemaPath,
          CODEGEN_SYNC_PROTOCOL_VERSION: String(protocolVersion),
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
