// @ts-check
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ClientFrameSchema, ServerFrameSchema, SyncCloseCodes, SyncCorrelationFieldsSchema, SyncProtocolMetadata } from "../../../sdks/typescript/client/src/generated/sync.ts";
import { SyncProtocolMetadata as SyncV3ProtocolMetadata, SyncV3ClientFrameSchema as ClientV3FrameSchema, SyncV3ServerFrameSchema as ServerV3FrameSchema, encodeSyncFrame as encodeV3SyncFrame } from "../../../sdks/typescript/client/src/generated/sync-v3.ts";
import { loadSyncContract, syncProtocolVersion } from "../src/emitters/sync-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const v1SchemaPath = resolve(repositoryRoot, "contract/schema/sync-v1.json");
const v3SchemaPath = resolve(repositoryRoot, "contract/schema/sync-v3.json");
const typeScriptEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/sync-typescript.mjs");
const elixirEmitter = resolve(repositoryRoot, "tools/contract-codegen/src/emitters/sync-elixir.mjs");
const generatedTypeScriptPath = resolve(repositoryRoot, "sdks/typescript/client/src/generated/sync.ts");
const generatedElixirPath = resolve(repositoryRoot, "apps/sync/lib/chalk_sync/contract/generated.ex");
const generatedV3TypeScriptPath = resolve(repositoryRoot, "sdks/typescript/client/src/generated/sync-v3.ts");
const generatedV3ElixirPath = resolve(repositoryRoot, "apps/sync/lib/chalk_sync/contract/generated_v3.ex");
const v3FixturePath = resolve(repositoryRoot, "contract/schema/fixtures/sync-v3/golden-frames.json");
const v3InvalidFixturePath = resolve(repositoryRoot, "contract/schema/fixtures/sync-v3/invalid-frames.json");
const expectedSnapshotMutationNames = [
  "participant_eligible_roles_empty",
  "participant_eligible_roles_duplicate",
  "participant_current_role_absent",
  "participant_host_missing_cohost_eligibility",
  "role_capabilities_duplicate",
  "participant_ids_duplicate",
  "admission_request_ids_duplicate",
  "pending_candidate_ids_duplicate",
  "active_pending_candidate_overlap",
  "participant_capabilities_not_ordered_exactly",
  "active_nonempty_host_null",
  "active_multiple_hosts",
  "active_host_id_role_mismatch",
  "active_empty_host_non_null",
  "ended_retains_participants",
  "ended_retains_admission_requests",
  "ended_retains_host",
  "ended_retains_recording",
  "admission_eligible_roles_empty",
  "admission_eligible_roles_duplicate",
  "admission_initial_role_absent",
  "admission_host_missing_cohost_eligibility",
  "recording_failed_without_failure_code",
  "recording_nonfailed_with_failure_code",
  "participant_display_name_empty",
  "admission_display_name_empty",
  "recording_failure_code_empty",
  "snapshot_unknown_field",
];

/** @typedef {Record<string, any>} JsonMap */
/** @typedef {{client_frames: JsonMap[], server_frames: JsonMap[]}} V3GoldenFixtures */
/** @typedef {{name: string, changes: {path: (number | string)[], value: unknown}[]}} SnapshotMutationFixture */
/** @typedef {V3GoldenFixtures & {snapshot_mutations: SnapshotMutationFixture[]}} V3InvalidFixtures */
/** @typedef {JsonMap & {operations: ({name: string, payload: JsonMap})[], events: ({name: string, origin: string, payload: JsonMap})[], externalIntents: string[]}} V3ContractFixture */

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

describe("sync v3 contract generation", () => {
  it("selects v3 explicitly and regenerates byte-identical TypeScript and Elixir goldens", async () => {
    expect(syncProtocolVersion("3")).toBe(3);
    expect(() => syncProtocolVersion("2")).toThrow('expected "1" or "3"');

    await withTemporaryDirectory(async (directory) => {
      const typeScriptOutput = resolve(directory, "sync-v3.ts");
      const elixirOutput = resolve(directory, "generated_v3.ex");
      await emit(typeScriptEmitter, "CODEGEN_SYNC_TYPESCRIPT_OUTPUT_PATH", typeScriptOutput, v3SchemaPath, 3);
      await emit(elixirEmitter, "CODEGEN_SYNC_ELIXIR_OUTPUT_PATH", elixirOutput, v3SchemaPath, 3);
      await expect(readFile(typeScriptOutput, "utf8")).resolves.toBe(await readFile(generatedV3TypeScriptPath, "utf8"));
      await expect(readFile(elixirOutput, "utf8")).resolves.toBe(await readFile(generatedV3ElixirPath, "utf8"));
    });
  }, 60_000);

  it("decodes and re-encodes every golden v3 frame", async () => {
    const fixtures = /** @type {V3GoldenFixtures} */ (JSON.parse(await readFile(v3FixturePath, "utf8")));
    const contract = /** @type {V3ContractFixture} */ (JSON.parse(await readFile(v3SchemaPath, "utf8")));
    const decodeClient = Schema.decodeUnknownSync(ClientV3FrameSchema);
    const decodeServer = Schema.decodeUnknownSync(ServerV3FrameSchema);
    fixtures.client_frames.forEach((frame) => expect(encodeV3SyncFrame(decodeClient(frame))).toBe(JSON.stringify(frame)));
    fixtures.server_frames.forEach((frame) => expect(encodeV3SyncFrame(decodeServer(frame))).toBe(JSON.stringify(frame)));
    expect(fixtures.client_frames.filter((frame) => frame.type === "operation").map((frame) => frame.name)).toEqual(contract.operations.map((operation) => operation.name));
    expect(fixtures.server_frames.filter((frame) => frame.type === "event").map((frame) => frame.name)).toEqual(contract.events.map((event) => event.name));
  });

  it("retains the control stream in the generated Elixir delivery acknowledgement", async () => {
    await withTemporaryDirectory(async (directory) => {
      const output = resolve(directory, "generated_v3.ex");
      await emit(elixirEmitter, "CODEGEN_SYNC_ELIXIR_OUTPUT_PATH", output, v3SchemaPath, 3);
      const generated = await readFile(output, "utf8");
      expect(generated).toContain("{:delivery_ack, %{stream: :control, revision: revision, state_digest: digest}}");
    });
  });

  it("rejects every malformed exact-key, bound, acknowledgement, projection, and snapshot-invariant fixture", async () => {
    const golden = /** @type {V3GoldenFixtures} */ (JSON.parse(await readFile(v3FixturePath, "utf8")));
    const fixtures = /** @type {V3InvalidFixtures} */ (JSON.parse(await readFile(v3InvalidFixturePath, "utf8")));
    const decodeClient = Schema.decodeUnknownSync(ClientV3FrameSchema);
    const decodeServer = Schema.decodeUnknownSync(ServerV3FrameSchema);
    fixtures.client_frames.forEach((frame) => expect(() => decodeClient(frame)).toThrow());
    fixtures.server_frames.forEach((frame) => expect(() => decodeServer(frame)).toThrow());
    expect(fixtures.snapshot_mutations.map((fixture) => fixture.name)).toEqual(expectedSnapshotMutationNames);
    snapshotMutationFrames(golden, fixtures).forEach((frame) => expect(() => decodeServer(frame)).toThrow());
  });

  it("accepts v3 goldens and rejects negative fixtures through the generated Elixir decoder", async () => {
    const golden = /** @type {V3GoldenFixtures} */ (JSON.parse(await readFile(v3FixturePath, "utf8")));
    const invalid = /** @type {V3InvalidFixtures} */ (JSON.parse(await readFile(v3InvalidFixturePath, "utf8")));
    const invalidServerFrames = [...invalid.server_frames, ...snapshotMutationFrames(golden, invalid)];
    const script = `
      Code.compile_file(${JSON.stringify(generatedV3ElixirPath)})
      golden = ${renderElixirTestValue(golden)}
      invalid = ${renderElixirTestValue(invalid)}
      invalid_server_frames = ${renderElixirTestValue(invalidServerFrames)}
      client_ok = Enum.all?(golden["client_frames"], &match?({:ok, _}, ChalkSync.Contract.GeneratedV3.decode_client_frame(&1)))
      server_ok = Enum.all?(golden["server_frames"], &ChalkSync.Contract.GeneratedV3.valid_server_frame?/1)
      client_rejected = Enum.all?(invalid["client_frames"], &match?({:error, _}, ChalkSync.Contract.GeneratedV3.decode_client_frame(&1)))
      server_rejected = Enum.all?(invalid_server_frames, &(not ChalkSync.Contract.GeneratedV3.valid_server_frame?(&1)))
      unless client_ok and server_ok and client_rejected and server_rejected, do: raise("generated v3 Elixir decoder fixture failure")
    `;
    await executeProcess("elixir", ["-e", script], repositoryRoot);
  }, 60_000);

  it("decodes every exact operation envelope and rejects unknown payload keys", async () => {
    const contract = /** @type {V3ContractFixture} */ (JSON.parse(await readFile(v3SchemaPath, "utf8")));
    const decodeClient = Schema.decodeUnknownSync(ClientV3FrameSchema);
    for (const [index, operation] of contract.operations.entries()) {
      const payload = Object.fromEntries(Object.keys(operation.payload).map((key) => [key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`), "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21"]));
      const frame = { type: "operation", command_id: `operation-command-${String(index).padStart(2, "0")}`, name: operation.name, payload };
      expect(decodeClient(frame)).toEqual(frame);
      expect(() => decodeClient({ ...frame, payload: { ...payload, unexpected: true } })).toThrow();
    }
  });

  it("decodes all eighteen exact control-event payloads and rejects payload or origin ambiguity", async () => {
    const contract = /** @type {V3ContractFixture} */ (JSON.parse(await readFile(v3SchemaPath, "utf8")));
    expect(contract.events).toHaveLength(18);
    const decodeServer = Schema.decodeUnknownSync(ServerV3FrameSchema);
    for (const [index, event] of contract.events.entries()) {
      const payload = Object.fromEntries(Object.entries(event.payload).map(([key, field]) => [key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`), sampleV3Field(field)]));
      const origin = event.origin === "external" ? contract.eventFrame.externalOriginField : event.origin === "lifecycle" ? contract.eventFrame.lifecycleOriginField : contract.eventFrame.commandOriginField;
      const frame = {
        type: "event",
        stream: "control",
        name: event.name,
        event_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
        base_revision: index,
        revision: index + 1,
        schema_version: 1,
        resulting_state_digest: "b".repeat(64),
        payload,
        [origin]: origin === contract.eventFrame.commandOriginField ? "event-command-001" : "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24",
      };
      expect(decodeServer(frame)).toMatchObject({ name: event.name, payload });
      if (event.origin === "command_or_external") {
        const externalFrame = { ...frame, [contract.eventFrame.externalOriginField]: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24" };
        delete externalFrame[contract.eventFrame.commandOriginField];
        expect(decodeServer(externalFrame)).toMatchObject({ name: event.name, payload });
      }
      expect(() => decodeServer({ ...frame, payload: { ...payload, unexpected: true } })).toThrow();
      const otherOrigin = origin === contract.eventFrame.commandOriginField ? contract.eventFrame.externalOriginField : contract.eventFrame.commandOriginField;
      expect(() => decodeServer({ ...frame, [otherOrigin]: "event-command-002" })).toThrow();
    }
  });

  it("accepts the populated active, pre-first-host active, and empty ended snapshot shapes", async () => {
    const fixtures = /** @type {V3GoldenFixtures} */ (JSON.parse(await readFile(v3FixturePath, "utf8")));
    const decodeServer = Schema.decodeUnknownSync(ServerV3FrameSchema);
    const fixtureWelcome = fixtures.server_frames.find((frame) => frame.type === "welcome" && frame.mode === "snapshot");
    if (!fixtureWelcome) throw new Error("golden v3 fixtures require a snapshot welcome frame");
    const welcome = structuredClone(fixtureWelcome);
    expect(decodeServer(welcome)).toMatchObject({ type: "welcome", mode: "snapshot" });
    welcome.snapshot.participants = [];
    welcome.snapshot.admission_requests = [];
    welcome.snapshot.host_participant_session_id = null;
    expect(decodeServer(welcome)).toMatchObject({ snapshot: { status: "active", host_participant_session_id: null } });
    welcome.snapshot.status = "ended";
    welcome.snapshot.recording = null;
    expect(decodeServer(welcome)).toMatchObject({ snapshot: { status: "ended", participants: [], admission_requests: [], host_participant_session_id: null, recording: null } });
    expect(SyncV3ProtocolMetadata.streams).toHaveProperty("requests.required", true);
    expect(SyncV3ProtocolMetadata.externalIntents).toEqual(expect.arrayContaining(["admission_request_expired", "tenant_set_deadline"]));
  });

  it("rejects a v3 source missing an exact frame declaration", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v3.json");
      const contract = /** @type {V3ContractFixture} */ (JSON.parse(await readFile(v3SchemaPath, "utf8")));
      delete contract.projectionFrames;
      await writeFile(invalidPath, JSON.stringify(contract));
      await expect(loadSyncContract(invalidPath, 3)).rejects.toThrow("projectionFrames is required");
    });
  });

  it("rejects a v3 source missing a durable event or external intent", async () => {
    await withTemporaryDirectory(async (directory) => {
      const missingEventPath = resolve(directory, "sync-v3-missing-event.json");
      const missingIntentPath = resolve(directory, "sync-v3-missing-intent.json");
      const contract = /** @type {V3ContractFixture} */ (JSON.parse(await readFile(v3SchemaPath, "utf8")));
      await writeFile(missingEventPath, JSON.stringify({ ...contract, events: contract.events.filter((event) => event.name !== "deadline_changed") }));
      await writeFile(missingIntentPath, JSON.stringify({ ...contract, externalIntents: contract.externalIntents.filter((intent) => intent !== "tenant_set_deadline") }));
      await expect(loadSyncContract(missingEventPath, 3)).rejects.toThrow("durable event set and origins must be exhaustive");
      await expect(loadSyncContract(missingIntentPath, 3)).rejects.toThrow("external intent set must be exhaustive");
    });
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
 * @param {string} executable
 * @param {string[]} arguments_
 * @param {string} cwd
 */
async function executeProcess(executable, arguments_, cwd) {
  await new Promise((resolvePromise, reject) => {
    execFile(executable, arguments_, { cwd, env: process.env }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolvePromise(undefined);
    });
  });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function renderElixirTestValue(value) {
  if (value === null) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(renderElixirTestValue).join(", ")}]`;
  if (typeof value !== "object") throw new Error("Elixir fixture values must be JSON-compatible");
  return `%{${Object.entries(value)
    .map(([key, child]) => `${JSON.stringify(key)} => ${renderElixirTestValue(child)}`)
    .join(", ")}}`;
}

/**
 * @param {V3GoldenFixtures} golden
 * @param {V3InvalidFixtures} invalid
 * @returns {JsonMap[]}
 */
function snapshotMutationFrames(golden, invalid) {
  const welcome = golden.server_frames.find((frame) => frame.type === "welcome" && frame.mode === "snapshot");
  if (!welcome) throw new Error("golden v3 fixtures require a snapshot welcome frame");
  return invalid.snapshot_mutations.map((fixture) => {
    const frame = structuredClone(welcome);
    fixture.changes.forEach((change) => setPath(frame.snapshot, change.path, change.value));
    return frame;
  });
}

/**
 * @param {any} target
 * @param {(number | string)[]} path
 * @param {unknown} value
 */
function setPath(target, path, value) {
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("snapshot mutation paths must not be empty");
  let parent = target;
  for (const segment of path.slice(0, -1)) parent = parent[segment];
  parent[last] = value;
}

/** @param {any} field */
function sampleV3Field(field) {
  if (field === "uuid" || field.format === "uuid") return "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
  if (Array.isArray(field)) return field[0];
  if (field.kind === "boolean") return true;
  if (field.kind === "integer") return field.minimum;
  if (field.kind === "array") return [];
  if (field.nullable) return null;
  return "value";
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
