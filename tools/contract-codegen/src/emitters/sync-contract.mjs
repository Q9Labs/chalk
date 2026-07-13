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
  if (value === "3") {
    return 3;
  }
  throw new Error(`Unsupported sync protocol version ${JSON.stringify(value)}; expected "1" or "3"`);
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
 * @param {string} message
 */
function validateV3FieldMap(value, message) {
  assertObject(value, message);
  Object.values(value).forEach((field) => {
    if (field === "uuid") return;
    if (Array.isArray(field)) {
      if (field.length === 0 || !field.every((item) => typeof item === "string") || new Set(field).size !== field.length) {
        throw new Error("Invalid sync v3 contract: enum shorthand fields must contain unique strings");
      }
      return;
    }
    validateField(field);
  });
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
  if (version === 3) {
    validateV3SyncContract(value);
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

  assertObject(value.correlation, "correlation is required");
  validateFieldMap(value.correlation.optionalTopLevelFields, "optional correlation fields are required");

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
 * @param {unknown} value
 */
function validateV3SyncContract(value) {
  assertObject(value, "the root must be an object");
  if (value.$schema !== "chalk.sync.v3" || value.version !== 3) {
    throw new Error("Invalid sync v3 contract: expected chalk.sync.v3 version 3");
  }

  const protocol = requireObjectProperty(value, "protocol", "protocol is required");
  if (protocol.value !== 3 || protocol.transport !== "websocket-json-text" || protocol.route !== "/v3/sync") {
    throw new Error("Invalid sync v3 contract: protocol must describe version 3 JSON text frames at /v3/sync");
  }

  const limits = requireObjectProperty(value, "limits", "limits are required");
  const expectedLimits = {
    decodedInboundFrameBytes: 65_536,
    tokenBytes: 8_192,
    commandIdMinBytes: 16,
    commandIdMaxBytes: 64,
    requestIdMinBytes: 16,
    requestIdMaxBytes: 64,
    decodedCommandPayloadBytes: 16_384,
    encodedLiveEventBytes: 32_768,
    replayPageMaxEvents: 128,
    replayPageEncodedBytes: 262_144,
    completeReplayMaxEvents: 2_048,
    completeReplayEncodedBytes: 2_097_152,
    snapshotEncodedBytes: 1_048_576,
    projectionSnapshotEncodedBytes: 1_048_576,
    projectionMaxItems: 1_500,
    directedRequestTtlMs: 30_000,
    directedRequestsPerActorTarget: 4,
    protocolErrorDetailBytes: 1_024,
  };
  for (const [property, expected] of Object.entries(expectedLimits)) {
    const actual = limits[property];
    if (typeof actual !== "number" || !Number.isInteger(actual) || actual !== expected) {
      throw new Error(`Invalid sync v3 contract: limits.${property} must equal ${expected}`);
    }
  }

  const digest = requireObjectProperty(value, "stateDigest", "state digest is required");
  if (digest.algorithm !== "sha256" || digest.prefix !== "chalk-sync-state-v3" || digest.versionEncoding !== "uint32-big-endian" || digest.projectionEncoding !== "rfc8785-json" || digest.wireEncoding !== "hex-lowercase") {
    throw new Error("Invalid sync v3 contract: state digest must declare the approved v3 SHA-256 encoding");
  }

  const streams = requireObjectProperty(value, "streams", "streams are required");
  if (JSON.stringify(Object.keys(streams)) !== JSON.stringify(["control", "media", "presence", "requests"])) {
    throw new Error("Invalid sync v3 contract: streams must declare control, media, presence, and requests");
  }

  const hello = requireObjectProperty(value, "hello", "hello is required");
  const helloStreams = requireObjectProperty(hello, "streams", "hello streams are required");
  if (hello.type !== "hello" || JSON.stringify(Object.keys(helloStreams)) !== JSON.stringify(Object.keys(streams))) {
    throw new Error("Invalid sync v3 contract: hello must declare exactly the four protocol streams");
  }
  validateField(hello.token);

  const commands = requireArrayProperty(value, "commands", "commands are required");
  const commandNames = commands.map((command) => {
    assertObject(command, "commands must be objects");
    const name = requireStringProperty(command, "name", "commands require a name");
    if (command.type !== "command") {
      throw new Error("Invalid sync v3 contract: command type must equal command");
    }
    validateV3FieldMap(command.payload, `command ${name} payload is required`);
    return name;
  });
  if (JSON.stringify(commandNames) !== JSON.stringify(["set_hand_raised", "set_display_name", "set_admission_policy", "set_participant_role", "transfer_host"])) {
    throw new Error("Invalid sync v3 contract: durable target command set must be exhaustive");
  }

  const operations = requireArrayProperty(value, "operations", "operations are required");
  const operationNames = operations.map((operation) => {
    assertObject(operation, "operations must be objects");
    const name = requireStringProperty(operation, "name", "operations require a name");
    if (operation.type !== "operation") {
      throw new Error("Invalid sync v3 contract: operation type must equal operation");
    }
    validateV3FieldMap(operation.payload, `operation ${name} payload is required`);
    return name;
  });
  const expectedOperations = ["admit_participant", "deny_admission", "mute_participant", "stop_participant_camera", "stop_participant_screen_share", "remove_participant", "start_recording", "stop_recording", "participant_leave", "end_session"];
  if (JSON.stringify(operationNames) !== JSON.stringify(expectedOperations)) {
    throw new Error("Invalid sync v3 contract: durable operation set must be exhaustive");
  }

  const expectedEvents = [
    ["participant_joined", "lifecycle"],
    ["participant_left", "external"],
    ["host_left_and_transferred", "external"],
    ["session_ended", "external"],
    ["hand_raised", "command"],
    ["hand_lowered", "command"],
    ["participant_display_name_changed", "command"],
    ["admission_policy_changed", "command"],
    ["participant_role_changed", "command"],
    ["host_transferred", "command_or_external"],
    ["deadline_changed", "external"],
    ["admission_requested", "lifecycle"],
    ["admission_denied", "external"],
    ["admission_expired", "external"],
    ["participant_microphone_stopped", "external"],
    ["participant_camera_stopped", "external"],
    ["participant_screen_share_stopped", "external"],
    ["recording_status_changed", "external"],
  ];
  const events = requireArrayProperty(value, "events", "events are required");
  const eventDefinitions = events.map((event) => {
    assertObject(event, "events must be objects");
    const name = requireStringProperty(event, "name", "events require a name");
    const origin = requireStringProperty(event, "origin", "events require an origin");
    if (!["command", "lifecycle", "external", "command_or_external"].includes(origin)) {
      throw new Error("Invalid sync v3 contract: event origin is invalid");
    }
    validateV3FieldMap(event.payload, `event ${name} payload is required`);
    return [name, origin];
  });
  if (JSON.stringify(eventDefinitions) !== JSON.stringify(expectedEvents)) {
    throw new Error("Invalid sync v3 contract: durable event set and origins must be exhaustive");
  }

  const externalIntents = requireArrayProperty(value, "externalIntents", "external intents are required");
  const expectedExternalIntents = [
    "admit_participant",
    "deny_admission",
    "admission_request_expired",
    "mute_participant",
    "stop_participant_camera",
    "stop_participant_screen_share",
    "remove_participant",
    "start_recording",
    "stop_recording",
    "participant_leave",
    "end_session",
    "tenant_transfer_host",
    "tenant_set_deadline",
    "tenant_end_session",
    "maximum_duration_expired",
  ];
  if (JSON.stringify(externalIntents) !== JSON.stringify(expectedExternalIntents)) {
    throw new Error("Invalid sync v3 contract: external intent set must be exhaustive");
  }

  const eventFrame = requireObjectProperty(value, "eventFrame", "event frame is required");
  if (
    eventFrame.direction !== "server-to-client" ||
    eventFrame.type !== "event" ||
    eventFrame.stream !== "control" ||
    JSON.stringify(eventFrame.commonExactFields) !== JSON.stringify(["type", "stream", "name", "event_id", "base_revision", "revision", "schema_version", "resulting_state_digest", "payload"]) ||
    eventFrame.commandOriginField !== "command_id" ||
    eventFrame.lifecycleOriginField !== "lifecycle_intent_id" ||
    eventFrame.externalOriginField !== "external_operation_id" ||
    eventFrame.originInvariant !== "exactly_one_origin_field"
  ) {
    throw new Error("Invalid sync v3 contract: event frame exact fields and origin fields must be exhaustive");
  }

  for (const property of ["capabilities", "liveTargets", "directedRequests", "rejectionReasons", "closeCodes"]) {
    requireArrayProperty(value, property, `${property} are required`);
  }
  for (const property of [
    "controlCursor",
    "snapshot",
    "deliveryAck",
    "recoveryAck",
    "welcome",
    "replayPage",
    "recoveryComplete",
    "projections",
    "operationFrame",
    "liveTargetFrames",
    "directedRequestFrames",
    "projectionFrames",
    "acks",
    "terminal",
    "retryableError",
    "error",
    "continuity",
    "idempotency",
  ]) {
    requireObjectProperty(value, property, `${property} is required`);
  }

  const liveTargetFrames = /** @type {JsonObject} */ (value.liveTargetFrames);
  for (const property of ["request", "result"]) {
    const frame = requireObjectProperty(liveTargetFrames, property, `liveTargetFrames.${property} is required`);
    requireArrayProperty(frame, "exactFields", `liveTargetFrames.${property}.exactFields are required`);
  }
  const directedRequestFrames = /** @type {JsonObject} */ (value.directedRequestFrames);
  for (const property of ["send", "deliver", "acknowledge", "result"]) {
    const frame = requireObjectProperty(directedRequestFrames, property, `directedRequestFrames.${property} is required`);
    requireArrayProperty(frame, "exactFields", `directedRequestFrames.${property}.exactFields are required`);
  }
  const projectionFrames = /** @type {JsonObject} */ (value.projectionFrames);
  for (const property of ["mediaSnapshot", "mediaEvent", "presenceSnapshot", "presenceEvent"]) {
    const frame = requireObjectProperty(projectionFrames, property, `projectionFrames.${property} is required`);
    requireArrayProperty(frame, "exactFields", `projectionFrames.${property}.exactFields are required`);
  }

  const acknowledgements = /** @type {JsonObject} */ (value.acks);
  if (JSON.stringify(acknowledgements.delivery) !== JSON.stringify(["original", "duplicate"]) || JSON.stringify(acknowledgements.outcomes) !== JSON.stringify(["committed", "satisfied", "rejected", "command_id_conflict"])) {
    throw new Error("Invalid sync v3 contract: acknowledgement delivery and outcomes must be exhaustive");
  }
  const retryableError = /** @type {JsonObject} */ (value.retryableError);
  const retryableCodes = requireArrayProperty(retryableError, "codes", "retryable error codes are required");
  if (JSON.stringify(retryableCodes) !== JSON.stringify(["overloaded", "server_draining", "dependency_unavailable", "decision_unavailable", "external_operation_pending"])) {
    throw new Error("Invalid sync v3 contract: retryable error codes must be exhaustive");
  }
  const error = /** @type {JsonObject} */ (value.error);
  if (JSON.stringify(error.code) !== JSON.stringify(["protocol_error", "invalid_frame", "unsupported_protocol"])) {
    throw new Error("Invalid sync v3 contract: protocol error codes must be exhaustive");
  }
  validateField(error.detail);
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
