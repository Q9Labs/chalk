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
 * @param {string} inputPath
 */
export async function loadSyncContract(inputPath = codegenPath("CODEGEN_SYNC_CONTRACT_PATH", "contract/schema/sync-v1.json")) {
  const source = await readFile(inputPath, "utf8");

  try {
    const parsed = new LocationPreservingJsonParser(source).parse();
    validateSyncContract(parsed.value);
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
 */
function validateSyncContract(value) {
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
