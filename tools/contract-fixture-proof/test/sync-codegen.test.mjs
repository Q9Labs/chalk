// @ts-check
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { SyncProtocolMetadata as SyncV1ProtocolMetadata, SyncV1ClientFrameSchema as ClientV1FrameSchema, SyncV1ServerFrameSchema as ServerV1FrameSchema, encodeSyncFrame as encodeV1SyncFrame } from "../../../sdks/typescript/client/src/generated/sync.ts";
import { loadSyncContract, syncProtocolVersion } from "../src/emitters/sync-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const v1SchemaPath = resolve(repositoryRoot, "contract/schema/sync-v1.json");
const typeScriptEmitter = resolve(repositoryRoot, "tools/contract-fixture-proof/src/emitters/sync-typescript.mjs");
const elixirEmitter = resolve(repositoryRoot, "tools/contract-fixture-proof/src/emitters/sync-elixir.mjs");
const generatedTypeScriptPath = resolve(repositoryRoot, "sdks/typescript/client/src/generated/sync.ts");
const generatedElixirPath = resolve(repositoryRoot, "apps/sync/lib/chalk_sync/contract/generated.ex");
const v1FixturePath = resolve(repositoryRoot, "contract/schema/fixtures/sync-v1/golden-frames.json");
const v1InvalidFixturePath = resolve(repositoryRoot, "contract/schema/fixtures/sync-v1/invalid-frames.json");
const expectedSnapshotMutationNames = [
  "role_capabilities_duplicate",
  "participant_capabilities_not_ordered_exactly",
  "participant_ids_duplicate",
  "admission_request_ids_duplicate",
  "pending_candidate_ids_duplicate",
  "active_pending_candidate_overlap",
  "ended_retains_participants",
  "ended_retains_admission_requests",
  "ended_retains_recording",
  "recording_failed_without_failure_code",
  "recording_nonfailed_with_failure_code",
  "participant_display_name_empty",
  "admission_display_name_empty",
  "recording_failure_code_empty",
  "snapshot_unknown_field",
];

/** @typedef {Record<string, any>} JsonMap */
/** @typedef {{client_frames: JsonMap[], server_frames: JsonMap[]}} V1GoldenFixtures */
/** @typedef {{name: string, changes: {path: (number | string)[], value: unknown}[]}} SnapshotMutationFixture */
/** @typedef {V1GoldenFixtures & {snapshot_mutations: SnapshotMutationFixture[]}} V1InvalidFixtures */
/** @typedef {JsonMap & {operations: ({name: string, payload: JsonMap})[], events: ({name: string, origin: string, payload: JsonMap})[], externalIntents: string[]}} V1ContractFixture */

describe("sync v1 contract generation", () => {
  it("accepts only v1 and regenerates byte-identical TypeScript and Elixir goldens", async () => {
    expect(syncProtocolVersion()).toBe(1);
    expect(syncProtocolVersion("1")).toBe(1);
    expect(() => syncProtocolVersion("2")).toThrow('expected "1"');
    expect(() => syncProtocolVersion("3")).toThrow('expected "1"');

    await withTemporaryDirectory(async (directory) => {
      const typeScriptOutput = resolve(directory, "sync.ts");
      const elixirOutput = resolve(directory, "generated.ex");
      await emit(typeScriptEmitter, "CODEGEN_SYNC_TYPESCRIPT_OUTPUT_PATH", typeScriptOutput, v1SchemaPath, 1);
      await emit(elixirEmitter, "CODEGEN_SYNC_ELIXIR_OUTPUT_PATH", elixirOutput, v1SchemaPath, 1);
      await expect(readFile(typeScriptOutput, "utf8")).resolves.toBe(await readFile(generatedTypeScriptPath, "utf8"));
      await expect(readFile(elixirOutput, "utf8")).resolves.toBe(await readFile(generatedElixirPath, "utf8"));
    });
  }, 60_000);

  it("decodes and re-encodes every golden v1 frame", async () => {
    const fixtures = /** @type {V1GoldenFixtures} */ (JSON.parse(await readFile(v1FixturePath, "utf8")));
    const contract = /** @type {V1ContractFixture} */ (JSON.parse(await readFile(v1SchemaPath, "utf8")));
    const decodeClient = Schema.decodeUnknownSync(ClientV1FrameSchema);
    const decodeServer = Schema.decodeUnknownSync(ServerV1FrameSchema);
    fixtures.client_frames.forEach((frame) => expect(encodeV1SyncFrame(decodeClient(frame))).toBe(JSON.stringify(frame)));
    fixtures.server_frames.forEach((frame) => expect(encodeV1SyncFrame(decodeServer(frame))).toBe(JSON.stringify(frame)));
    expect(fixtures.client_frames.filter((frame) => frame.type === "operation").map((frame) => frame.name)).toEqual(contract.operations.map((operation) => operation.name));
    expect(fixtures.server_frames.filter((frame) => frame.type === "event").map((frame) => frame.name)).toEqual(contract.events.map((event) => event.name));
    const hello = fixtures.client_frames.find((frame) => frame.type === "hello");
    if (!hello) throw new Error("golden v1 fixtures require a hello frame");
    const partialHello = structuredClone(hello);
    delete partialHello.tracestate;
    expect(decodeClient(partialHello)).toMatchObject({ journey_id: hello.journey_id, traceparent: hello.traceparent });
    expect(() => decodeClient({ ...partialHello, unexpected: true })).toThrow();
    expect(decodeServer({ type: "pong", journey_id: hello.journey_id })).toEqual({ type: "pong", journey_id: hello.journey_id });
    expect(() => decodeServer({ type: "pong", tracestate: "x".repeat(513) })).toThrow();
  });

  it("reserves the escaped maximum correlation object for near-limit chat pages", () => {
    const limits = SyncV1ProtocolMetadata.limits;
    const correlation = maximumCorrelation();
    const producerLimit = limits.chatPageEncodedBytes - limits.correlationReservedBytes;
    const frame = nearLimitChatPage(producerLimit);
    const correlated = { ...frame, ...correlation };
    const oversized = nearLimitChatPage(producerLimit + 1);
    const decodeServer = Schema.decodeUnknownSync(ServerV1FrameSchema);

    expect(new TextEncoder().encode(JSON.stringify(correlation)).byteLength).toBe(limits.correlationReservedBytes);
    expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBe(producerLimit);
    expect(new TextEncoder().encode(JSON.stringify(correlated)).byteLength).toBeLessThanOrEqual(limits.chatPageEncodedBytes);
    expect(decodeServer(frame)).toEqual(frame);
    expect(decodeServer(correlated)).toEqual(correlated);
    expect(() => decodeServer(oversized)).toThrow();
  });

  it("retains the control stream in the generated Elixir delivery acknowledgement", async () => {
    await withTemporaryDirectory(async (directory) => {
      const output = resolve(directory, "generated.ex");
      await emit(elixirEmitter, "CODEGEN_SYNC_ELIXIR_OUTPUT_PATH", output, v1SchemaPath, 1);
      const generated = await readFile(output, "utf8");
      expect(generated).toContain("{:delivery_ack, %{stream: :control, revision: revision, state_digest: digest}}");
    });
  });

  it("rejects every malformed exact-key, bound, acknowledgement, projection, and snapshot-invariant fixture", async () => {
    const golden = /** @type {V1GoldenFixtures} */ (JSON.parse(await readFile(v1FixturePath, "utf8")));
    const fixtures = /** @type {V1InvalidFixtures} */ (JSON.parse(await readFile(v1InvalidFixturePath, "utf8")));
    const decodeClient = Schema.decodeUnknownSync(ClientV1FrameSchema);
    const decodeServer = Schema.decodeUnknownSync(ServerV1FrameSchema);
    fixtures.client_frames.forEach((frame) => expect(() => decodeClient(frame)).toThrow());
    fixtures.server_frames.forEach((frame) => expect(() => decodeServer(frame)).toThrow());
    const zeroParentTraceHello = fixtures.client_frames.find((frame) => frame.traceparent === "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01");
    expect(zeroParentTraceHello).toBeDefined();
    if (zeroParentTraceHello) expect(() => decodeClient(zeroParentTraceHello)).toThrow();
    const nonHelloCorrelationFrame = fixtures.client_frames.find((frame) => frame.type === "ping" && frame.journey_id === "00000000-0000-4000-8000-000000000042");
    expect(nonHelloCorrelationFrame).toBeDefined();
    if (nonHelloCorrelationFrame) expect(() => decodeClient(nonHelloCorrelationFrame)).toThrow();
    expect(fixtures.snapshot_mutations.map((fixture) => fixture.name)).toEqual(expectedSnapshotMutationNames);
    snapshotMutationFrames(golden, fixtures).forEach((frame) => expect(() => decodeServer(frame)).toThrow());
  });

  it("accepts v1 goldens and rejects negative fixtures through the generated Elixir decoder", async () => {
    const golden = /** @type {V1GoldenFixtures} */ (JSON.parse(await readFile(v1FixturePath, "utf8")));
    const invalid = /** @type {V1InvalidFixtures} */ (JSON.parse(await readFile(v1InvalidFixturePath, "utf8")));
    const invalidServerFrames = [...invalid.server_frames, ...snapshotMutationFrames(golden, invalid)];
    const script = `
      Code.compile_file(${JSON.stringify(generatedElixirPath)})
      golden = ${renderElixirTestValue(golden)}
      invalid = ${renderElixirTestValue(invalid)}
      invalid_server_frames = ${renderElixirTestValue(invalidServerFrames)}
      client_ok = Enum.all?(golden["client_frames"], &match?({:ok, _}, ChalkSync.Contract.GeneratedV1.decode_client_frame(&1)))
      server_ok = Enum.all?(golden["server_frames"], &ChalkSync.Contract.GeneratedV1.valid_server_frame?/1)
      client_rejected = Enum.all?(invalid["client_frames"], &match?({:error, _}, ChalkSync.Contract.GeneratedV1.decode_client_frame(&1)))
      server_rejected = Enum.all?(invalid_server_frames, &(not ChalkSync.Contract.GeneratedV1.valid_server_frame?(&1)))
      unless client_ok and server_ok and client_rejected and server_rejected, do: raise("generated v1 Elixir decoder fixture failure")
    `;
    await executeProcess("elixir", ["-e", script], repositoryRoot);
  }, 60_000);

  it("decodes every exact operation envelope and rejects unknown payload keys", async () => {
    const contract = /** @type {V1ContractFixture} */ (JSON.parse(await readFile(v1SchemaPath, "utf8")));
    const decodeClient = Schema.decodeUnknownSync(ClientV1FrameSchema);
    for (const [index, operation] of contract.operations.entries()) {
      const payload = Object.fromEntries(Object.entries(operation.payload).map(([key, field]) => [key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`), sampleField(field)]));
      const frame = { type: "operation", command_id: `operation-command-${String(index).padStart(2, "0")}`, name: operation.name, payload };
      expect(decodeClient(frame)).toEqual(frame);
      expect(() => decodeClient({ ...frame, payload: { ...payload, unexpected: true } })).toThrow();
    }
  });

  it("decodes all seventeen exact control-event payloads and rejects payload or origin ambiguity", async () => {
    const contract = /** @type {V1ContractFixture} */ (JSON.parse(await readFile(v1SchemaPath, "utf8")));
    expect(contract.events).toHaveLength(17);
    const decodeServer = Schema.decodeUnknownSync(ServerV1FrameSchema);
    for (const [index, event] of contract.events.entries()) {
      const payload = Object.fromEntries(Object.entries(event.payload).map(([key, field]) => [key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`), sampleField(field)]));
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

  it("accepts populated active and empty ended snapshot shapes", async () => {
    const fixtures = /** @type {V1GoldenFixtures} */ (JSON.parse(await readFile(v1FixturePath, "utf8")));
    const decodeServer = Schema.decodeUnknownSync(ServerV1FrameSchema);
    const fixtureWelcome = fixtures.server_frames.find((frame) => frame.type === "welcome" && frame.mode === "snapshot");
    if (!fixtureWelcome) throw new Error("golden v1 fixtures require a snapshot welcome frame");
    const welcome = structuredClone(fixtureWelcome);
    expect(decodeServer(welcome)).toMatchObject({ type: "welcome", mode: "snapshot" });
    welcome.snapshot.participants = [];
    welcome.snapshot.admission_requests = [];
    expect(decodeServer(welcome)).toMatchObject({ snapshot: { status: "active", participants: [], admission_requests: [] } });
    welcome.snapshot.status = "ended";
    welcome.snapshot.recording = null;
    expect(decodeServer(welcome)).toMatchObject({ snapshot: { status: "ended", participants: [], admission_requests: [], recording: null } });
    expect(SyncV1ProtocolMetadata.streams).toHaveProperty("requests.required", true);
    expect(SyncV1ProtocolMetadata.externalIntents).toEqual(expect.arrayContaining(["admission_request_expired", "tenant_set_deadline"]));
  });

  it("rejects a v1 source missing an exact frame declaration", async () => {
    await withTemporaryDirectory(async (directory) => {
      const invalidPath = resolve(directory, "sync-v1.json");
      const contract = /** @type {V1ContractFixture} */ (JSON.parse(await readFile(v1SchemaPath, "utf8")));
      delete contract.projectionFrames;
      await writeFile(invalidPath, JSON.stringify(contract));
      await expect(loadSyncContract(invalidPath, 1)).rejects.toThrow("projectionFrames is required");
    });
  });

  it("rejects a v1 source missing a durable event or external intent", async () => {
    await withTemporaryDirectory(async (directory) => {
      const missingEventPath = resolve(directory, "sync-v1-missing-event.json");
      const missingIntentPath = resolve(directory, "sync-v1-missing-intent.json");
      const contract = /** @type {V1ContractFixture} */ (JSON.parse(await readFile(v1SchemaPath, "utf8")));
      await writeFile(missingEventPath, JSON.stringify({ ...contract, events: contract.events.filter((event) => event.name !== "deadline_changed") }));
      await writeFile(missingIntentPath, JSON.stringify({ ...contract, externalIntents: contract.externalIntents.filter((intent) => intent !== "tenant_set_deadline") }));
      await expect(loadSyncContract(missingEventPath, 1)).rejects.toThrow("durable event set and origins must be exhaustive");
      await expect(loadSyncContract(missingIntentPath, 1)).rejects.toThrow("external intent set must be exhaustive");
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
 * @param {V1GoldenFixtures} golden
 * @param {V1InvalidFixtures} invalid
 * @returns {JsonMap[]}
 */
function snapshotMutationFrames(golden, invalid) {
  const welcome = golden.server_frames.find((frame) => frame.type === "welcome" && frame.mode === "snapshot");
  if (!welcome) throw new Error("golden v1 fixtures require a snapshot welcome frame");
  return invalid.snapshot_mutations.map((fixture) => {
    const frame = structuredClone(welcome);
    fixture.changes.forEach((change) => setPath(frame.snapshot, change.path, change.value));
    return frame;
  });
}

function maximumCorrelation() {
  return {
    journey_id: "00000000-0000-4000-8000-000000000042",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    tracestate: `a=${"\\".repeat(256)},b=${"\\".repeat(251)}`,
  };
}

/** @param {number} targetBytes @returns {JsonMap} */
function nearLimitChatPage(targetBytes) {
  const messages = Array.from({ length: 31 }, (_, index) => chatMessage(index, index === 30 ? 0 : 4_000));
  const frame = {
    type: "chat_page",
    request_id: "chat-page-request-01",
    outcome: "loaded",
    messages,
    has_more: false,
    head_sequence: "8",
    retained_floor_sequence: "1",
  };
  const baseBytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
  const lastMessage = frame.messages.at(-1);
  if (!lastMessage) throw new Error("near-limit chat page requires a last message");
  lastMessage.text = "x".repeat(targetBytes - baseBytes);
  return frame;
}

/** @param {number} index @param {number} textLength @returns {JsonMap} */
function chatMessage(index, textLength) {
  return {
    type: "chat_message",
    message_id: `018f2f65-2a77-7a44-8e9a-5b0b6f8d4c${String(index + 23).padStart(2, "0")}`,
    client_message_id: `chat-message-id-${String(index).padStart(2, "0")}`,
    sequence: String(index + 1),
    participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4cff",
    display_name: "name",
    text: "x".repeat(textLength),
    attachments: [],
    created_at: "2026-08-05T00:00:00Z",
  };
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
function sampleField(field) {
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
