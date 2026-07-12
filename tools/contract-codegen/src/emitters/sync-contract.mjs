// @ts-check

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonSourceDiagnostic, LocationPreservingJsonParser } from "../json-parser.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(sourceDirectory, "../../../..");
const supportedFieldKinds = new Set(["array", "boolean", "integer", "object", "string"]);

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * @param {string} environmentVariable
 * @param {string} fallback
 */
export function codegenPath(environmentVariable, fallback) {
  return path.resolve(process.env[environmentVariable] ?? path.resolve(repositoryRoot, fallback));
}

/**
 * @param {string | undefined} value
 */
export function syncProtocolVersion(value = process.env.CODEGEN_SYNC_PROTOCOL_VERSION) {
  if (value === undefined || value === "1") {
    return 1;
  }
  if (value === "2") {
    return 2;
  }
  throw new Error(`Unsupported sync protocol version ${JSON.stringify(value)}; expected "1" or "2"`);
}

/**
 * @param {number} version
 */
export function syncContractPath(version) {
  return codegenPath("CODEGEN_SYNC_CONTRACT_PATH", `contract/schema/sync-v${version}.json`);
}

/**
 * @param {string} inputPath
 * @param {number} version
 */
export async function loadSyncContract(inputPath = syncContractPath(syncProtocolVersion()), version = syncProtocolVersion()) {
  const source = await readFile(inputPath, "utf8");

  try {
    const parsed = new LocationPreservingJsonParser(source).parse();
    validateSyncContract(parsed.value, version);
    return /** @type {JsonObject} */ (parsed.value);
  } catch (error) {
    if (error instanceof JsonSourceDiagnostic) {
      throw new Error(`${inputPath}:${error.location.line}:${error.location.column}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * @param {unknown} value
 * @param {string} message
 * @returns {asserts value is JsonObject}
 */
function assertObject(value, message) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid sync v1 contract: ${message}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} message
 * @returns {asserts value is unknown[]}
 */
function assertArray(value, message) {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid sync v1 contract: ${message}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} message
 * @returns {asserts value is string}
 */
function assertString(value, message) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid sync v1 contract: ${message}`);
  }
}

/**
 * @param {unknown} value
 */
function validateField(value) {
  assertObject(value, "field definitions must be objects");
  assertString(value.kind, "field definitions require a kind");
  if (!supportedFieldKinds.has(value.kind)) {
    throw new Error(`Invalid sync v1 contract: unsupported field kind ${JSON.stringify(value.kind)}`);
  }
  if (value.kind === "integer") {
    const minimum = value.minimum;
    if (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 0) {
      throw new Error("Invalid sync v1 contract: integer fields require a nonnegative integer minimum");
    }
  }
  if (value.kind === "array") {
    if (value.items !== undefined) {
      assertObject(value.items, "array field items must be an object");
    } else {
      assertString(value.of, "array fields require items or an of reference");
    }
  }
  if (value.kind === "object" && value.additionalProperties !== true) {
    throw new Error("Invalid sync v1 contract: object fields must explicitly allow additional properties");
  }
}

/**
 * @param {unknown} value
 */
function validateNestedFieldDefinitions(value) {
  if (Array.isArray(value)) {
    value.forEach(validateNestedFieldDefinitions);
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  const object = /** @type {JsonObject} */ (value);
  if (Object.hasOwn(object, "kind")) {
    validateField(object);
  }
  Object.values(object).forEach(validateNestedFieldDefinitions);
}

/**
 * @param {unknown} value
 */
function validateNamedFrames(value) {
  assertArray(value, "commands, events, and acknowledgements must be arrays");
  value.forEach((frame) => {
    assertObject(frame, "frames must be objects");
    assertString(frame.type, "frames require a type");
  });
}

/**
 * @param {unknown} value
 * @param {string} message
 */
function validateFieldMap(value, message) {
  assertObject(value, message);
  Object.values(value).forEach(validateField);
}

/**
 * @param {unknown} value
 */
function validateWelcomeModes(value) {
  assertArray(value, "welcome modes are required");
  value.forEach((mode) => {
    assertObject(mode, "welcome modes must be objects");
    assertString(mode.id, "welcome modes require an id");
    if (mode.id === "snapshot") {
      assertObject(mode.snapshot, "snapshot welcome mode requires a snapshot");
      validateField(mode.snapshot.controlRevision);
      validateField(mode.snapshot.participants);
      assertObject(mode.snapshot.participants, "snapshot participants must be a field definition");
      validateFieldMap(mode.snapshot.participants.items, "snapshot participant fields are required");
      return;
    }
    if (mode.id === "replay") {
      validateField(mode.controlRevision);
      validateField(mode.events);
      return;
    }
    throw new Error(`Invalid sync v1 contract: unsupported welcome mode ${JSON.stringify(mode.id)}`);
  });
}

/**
 * @param {unknown} value
 * @param {number} version
 */
function validateSyncContract(value, version) {
  if (version === 1) {
    validateV1SyncContract(value);
    return;
  }
  if (version === 2) {
    validateV2SyncContract(value);
    return;
  }
  throw new Error(`Unsupported sync protocol version ${JSON.stringify(version)}`);
}

/**
 * @param {unknown} value
 */
function validateV1SyncContract(value) {
  assertObject(value, "the root must be an object");
  if (value.$schema !== "chalk.sync.v1" || value.version !== 1) {
    throw new Error("Invalid sync v1 contract: expected chalk.sync.v1 version 1");
  }
  validateNestedFieldDefinitions(value);

  assertObject(value.protocol, "protocol is required");
  if (value.protocol.value !== 1 || value.protocol.transport !== "websocket-json-text") {
    throw new Error("Invalid sync v1 contract: protocol must describe version 1 JSON text frames");
  }

  assertArray(value.phases, "phases are required");
  assertObject(value.hello, "hello is required");
  validateField(value.hello.token);
  validateField(value.hello.cursor);
  assertObject(value.welcome, "welcome is required");
  validateField(value.welcome.participantId);
  validateWelcomeModes(value.welcome.modes);
  const commands = value.commands;
  assertArray(commands, "commands must be an array");
  validateNamedFrames(commands);
  commands.forEach((command) => {
    assertObject(command, "commands must be objects");
    validateField(command.commandId);
    validateField(command.payload);
  });
  const events = value.events;
  assertArray(events, "events must be an array");
  validateNamedFrames(events);
  events.forEach((event) => {
    assertObject(event, "events must be objects");
    validateField(event.baseRevision);
    validateField(event.revision);
    validateFieldMap(event.payload, "event payloads must be objects");
  });
  const acknowledgements = value.acks;
  assertArray(acknowledgements, "acknowledgements must be an array");
  validateNamedFrames(acknowledgements);
  acknowledgements.forEach((ack) => {
    assertObject(ack, "acknowledgements must be objects");
    validateField(ack.commandId);
    if (ack.revision !== undefined) {
      validateField(ack.revision);
    }
    if (ack.reason !== undefined) {
      validateField(ack.reason);
    }
  });
  assertObject(value.error, "error is required");
  validateField(value.error.code);
  validateField(value.error.message);
  assertObject(value.ping, "ping is required");
  assertObject(value.pong, "pong is required");
  assertObject(value.continuity, "continuity is required");
  assertObject(value.idempotency, "idempotency is required");
  assertArray(value.closeCodes, "close codes are required");
}

/**
 * @param {JsonObject} value
 * @param {string} property
 * @param {string} message
 */
function requireObjectProperty(value, property, message) {
  assertObject(value[property], message);
  return /** @type {JsonObject} */ (value[property]);
}

/**
 * @param {JsonObject} value
 * @param {string} property
 * @param {string} message
 */
function requireArrayProperty(value, property, message) {
  assertArray(value[property], message);
  return /** @type {unknown[]} */ (value[property]);
}

/**
 * @param {JsonObject} value
 * @param {string} property
 * @param {string} message
 */
function requireStringProperty(value, property, message) {
  assertString(value[property], message);
  return /** @type {string} */ (value[property]);
}

/**
 * @param {JsonObject} value
 * @param {string} property
 * @param {string} message
 */
function requireNonNegativeIntegerProperty(value, property, message) {
  const number = value[property];
  if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid sync v2 contract: ${message}`);
  }
  return number;
}

/**
 * @param {JsonObject} value
 * @param {string[]} properties
 * @param {string} message
 */
function requireProperties(value, properties, message) {
  for (const property of properties) {
    if (!Object.hasOwn(value, property)) {
      throw new Error(`Invalid sync v2 contract: ${message}: missing ${property}`);
    }
  }
}

/**
 * @param {unknown} value
 */
function validateV2SyncContract(value) {
  assertObject(value, "the root must be an object");
  if (value.$schema !== "chalk.sync.v2" || value.version !== 2) {
    throw new Error("Invalid sync v2 contract: expected chalk.sync.v2 version 2");
  }

  const protocol = requireObjectProperty(value, "protocol", "protocol is required");
  if (protocol.value !== 2 || protocol.transport !== "websocket-json-text" || protocol.route !== "/v2/sync") {
    throw new Error("Invalid sync v2 contract: protocol must describe version 2 JSON text frames at /v2/sync");
  }

  const limits = requireObjectProperty(value, "limits", "limits are required");
  for (const property of [
    "decodedInboundFrameBytes",
    "tokenBytes",
    "commandIdMinBytes",
    "commandIdMaxBytes",
    "decodedCommandPayloadBytes",
    "encodedLiveEventBytes",
    "replayPageMaxEvents",
    "replayPageEncodedBytes",
    "completeReplayMaxEvents",
    "completeReplayEncodedBytes",
    "snapshotEncodedBytes",
    "protocolErrorDetailBytes",
  ]) {
    requireNonNegativeIntegerProperty(limits, property, `limits.${property} must be a nonnegative integer`);
  }

  const expectedLimits = {
    decodedInboundFrameBytes: 65_536,
    tokenBytes: 8_192,
    commandIdMinBytes: 16,
    commandIdMaxBytes: 64,
    decodedCommandPayloadBytes: 16_384,
    encodedLiveEventBytes: 32_768,
    replayPageMaxEvents: 128,
    replayPageEncodedBytes: 262_144,
    completeReplayMaxEvents: 2_048,
    completeReplayEncodedBytes: 2_097_152,
    snapshotEncodedBytes: 1_048_576,
    protocolErrorDetailBytes: 1_024,
  };
  for (const [property, expected] of Object.entries(expectedLimits)) {
    if (limits[property] !== expected) {
      throw new Error(`Invalid sync v2 contract: limits.${property} must equal ${expected}`);
    }
  }

  const digest = requireObjectProperty(value, "stateDigest", "state digest is required");
  if (digest.algorithm !== "sha256" || digest.prefix !== "chalk-sync-state-v2" || digest.versionEncoding !== "uint32-big-endian" || digest.projectionEncoding !== "rfc8785-json" || digest.wireEncoding !== "hex-lowercase") {
    throw new Error("Invalid sync v2 contract: state digest must declare the approved v2 SHA-256 encoding");
  }

  const cursor = requireObjectProperty(value, "controlCursor", "control cursor is required");
  requireProperties(cursor, ["revision", "stateSchemaVersion", "stateDigest"], "control cursor fields are required");
  validateField(cursor.revision);
  validateField(cursor.stateSchemaVersion);
  validateField(cursor.stateDigest);

  const snapshot = requireObjectProperty(value, "snapshot", "snapshot is required");
  requireProperties(snapshot, ["controlRevision", "stateSchemaVersion", "stateDigest", "status", "participants"], "snapshot fields are required");
  validateField(snapshot.controlRevision);
  validateField(snapshot.stateSchemaVersion);
  validateField(snapshot.stateDigest);
  validateField(snapshot.status);
  const participants = requireObjectProperty(snapshot, "participants", "snapshot participants are required");
  validateField(participants);
  assertObject(participants.items, "snapshot participant fields are required");
  for (const field of ["participantSessionId", "displayName", "handRaised"]) {
    validateField(participants.items[field]);
  }

  const hello = requireObjectProperty(value, "hello", "hello is required");
  if (hello.type !== "hello") {
    throw new Error("Invalid sync v2 contract: hello type must equal hello");
  }
  validateField(hello.token);

  const deliveryAck = requireObjectProperty(value, "deliveryAck", "delivery acknowledgement is required");
  requireProperties(deliveryAck, ["type", "stream", "revision", "stateDigest"], "delivery acknowledgement fields are required");
  if (deliveryAck.direction !== "client-to-server" || deliveryAck.type !== "delivery_ack" || deliveryAck.stream !== "control") {
    throw new Error("Invalid sync v2 contract: delivery acknowledgement must be the control delivery_ack client frame");
  }
  validateField(deliveryAck.revision);
  validateField(deliveryAck.stateDigest);

  const recoveryAck = requireObjectProperty(value, "recoveryAck", "recovery acknowledgement is required");
  requireProperties(recoveryAck, ["type", "recoveryId", "revision", "stateDigest"], "recovery acknowledgement fields are required");
  if (recoveryAck.direction !== "client-to-server" || recoveryAck.type !== "recovery_ack") {
    throw new Error("Invalid sync v2 contract: recovery acknowledgement must be the recovery_ack client frame");
  }
  validateField(recoveryAck.recoveryId);
  validateField(recoveryAck.revision);
  validateField(recoveryAck.stateDigest);

  const welcome = requireObjectProperty(value, "welcome", "welcome is required");
  requireProperties(welcome, ["type", "participantSessionId", "participantSessionGeneration", "recoveryId", "head", "modes"], "welcome fields are required");
  if (welcome.type !== "welcome") {
    throw new Error("Invalid sync v2 contract: welcome type must equal welcome");
  }
  validateField(welcome.participantSessionId);
  validateField(welcome.participantSessionGeneration);
  validateField(welcome.recoveryId);
  if (welcome.head !== "controlCursor") {
    throw new Error("Invalid sync v2 contract: welcome head must reference controlCursor");
  }
  const modes = requireArrayProperty(welcome, "modes", "welcome modes are required");
  const modeIds = modes.map((mode) => {
    assertObject(mode, "welcome modes must be objects");
    return requireStringProperty(mode, "id", "welcome modes require an id");
  });
  if (JSON.stringify(modeIds) !== JSON.stringify(["snapshot", "replay", "up_to_date", "terminal"])) {
    throw new Error("Invalid sync v2 contract: welcome modes must be snapshot, replay, up_to_date, terminal");
  }

  const commands = requireArrayProperty(value, "commands", "commands are required");
  if (commands.length === 0) {
    throw new Error("Invalid sync v2 contract: at least one command is required");
  }
  commands.forEach((command) => {
    assertObject(command, "commands must be objects");
    requireStringProperty(command, "name", "commands require a name");
    if (command.type !== "command") {
      throw new Error("Invalid sync v2 contract: command type must equal command");
    }
  });

  const events = requireArrayProperty(value, "events", "events are required");
  if (events.length === 0) {
    throw new Error("Invalid sync v2 contract: at least one event is required");
  }
  events.forEach((event) => {
    assertObject(event, "events must be objects");
    requireStringProperty(event, "name", "events require a name");
    if (!["command", "lifecycle"].includes(requireStringProperty(event, "origin", "events require an origin"))) {
      throw new Error("Invalid sync v2 contract: event origins must be command or lifecycle");
    }
  });

  const acks = requireArrayProperty(value, "acks", "acknowledgements are required");
  const ackResults = acks.map((ack) => {
    assertObject(ack, "acknowledgements must be objects");
    return requireStringProperty(ack, "result", "acknowledgements require a result");
  });
  if (JSON.stringify(ackResults) !== JSON.stringify(["committed", "duplicate", "rejected"])) {
    throw new Error("Invalid sync v2 contract: acknowledgements must be committed, duplicate, rejected");
  }

  const terminal = requireObjectProperty(value, "terminal", "terminal recovery is required");
  const terminalReasons = requireArrayProperty(terminal, "reasons", "terminal reasons are required");
  if (JSON.stringify(terminalReasons) !== JSON.stringify(["session_ended", "participant_inactive", "stale_participant_generation"])) {
    throw new Error("Invalid sync v2 contract: terminal reasons must be exhaustive");
  }

  const retryableError = requireObjectProperty(value, "retryableError", "retryable error is required");
  const retryableCodes = requireArrayProperty(retryableError, "codes", "retryable error codes are required");
  if (JSON.stringify(retryableCodes) !== JSON.stringify(["overloaded", "server_draining", "dependency_unavailable", "decision_unavailable"])) {
    throw new Error("Invalid sync v2 contract: retryable error codes must be exhaustive");
  }

  const error = requireObjectProperty(value, "error", "error is required");
  validateField(error.detail);
  const rejection = requireArrayProperty(value, "rejectionReasons", "rejection reasons are required");
  if (JSON.stringify(rejection) !== JSON.stringify(["session_ended", "participant_inactive", "stale_participant_generation", "capability_denied", "invalid_state", "command_id_conflict"])) {
    throw new Error("Invalid sync v2 contract: rejection reasons must be exhaustive");
  }
  assertArray(value.closeCodes, "close codes are required");
}

/**
 * @param {string} value
 */
export function pascalCase(value) {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

/**
 * @param {unknown} value
 */
export function stableJson(value) {
  return JSON.stringify(value, null, 2);
}
