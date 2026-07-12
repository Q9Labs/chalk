import type { ControlParticipant, ControlState } from "./types";

const digestPrefix = new TextEncoder().encode("chalk-sync-state-v2\0");
const encoder = new TextEncoder();

export type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

export function durableControlProjection(state: ControlState, revision: number, stateSchemaVersion: number): CanonicalJson {
  assertControlRevision(revision);
  assertStateSchemaVersion(stateSchemaVersion);
  return {
    control_revision: revision,
    participants: [...state.participants].sort(compareParticipants).map((participant) => ({
      display_name: participant.displayName,
      hand_raised: participant.handRaised,
      participant_session_id: participant.participantSessionId,
    })),
    state_schema_version: stateSchemaVersion,
    status: state.status,
  };
}

function assertControlRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError("control revision must be a non-negative integer");
  }
}

function assertStateSchemaVersion(stateSchemaVersion: number): void {
  if (!Number.isSafeInteger(stateSchemaVersion) || stateSchemaVersion < 1 || stateSchemaVersion > 0xffffffff) {
    throw new RangeError("state schema version must fit a positive unsigned 32-bit integer");
  }
}

export function canonicalJson(value: CanonicalJson): string {
  return serialize(value);
}

export function canonicalJsonBytes(value: CanonicalJson): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

export async function computeStateDigest(state: ControlState, revision: number, stateSchemaVersion: number): Promise<string> {
  const projection = durableControlProjection(state, revision, stateSchemaVersion);

  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, stateSchemaVersion, false);
  const bytes = concatBytes(digestPrefix, version, canonicalJsonBytes(projection));
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }

  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await cryptoApi.subtle.digest("SHA-256", input);
  return toHex(new Uint8Array(digest));
}

export function compareParticipants(left: ControlParticipant, right: ControlParticipant): number {
  return compareUnicodeCodeUnits(left.participantSessionId, right.participantSessionId);
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  if (typeof value === "object") {
    return serializeObject(value as { readonly [key: string]: unknown });
  }
  return serializeScalar(value);
}

function serializeScalar(value: unknown): string {
  switch (typeof value) {
    case "string":
      return serializeString(value);
    case "number":
      return serializeNumber(value);
    case "boolean":
      return JSON.stringify(value);
    default:
      throw new TypeError("canonical JSON only supports JSON values");
  }
}

function serializeString(value: string): string {
  assertWellFormedUnicode(value);
  return JSON.stringify(value);
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("canonical JSON does not support non-finite numbers");
  }
  return JSON.stringify(value);
}

function serializeObject(value: { readonly [key: string]: unknown }): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("canonical JSON only supports plain objects");
  }

  const keys = Object.keys(value).sort(compareUnicodeCodeUnits);
  return `{${keys.map((key) => `${serialize(key)}:${serialize(value[key])}`).join(",")}}`;
}

function compareUnicodeCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isSurrogate(code)) {
      continue;
    }

    const next = value.charCodeAt(index + 1);
    if (isSurrogatePair(code, next)) {
      index += 1;
      continue;
    }
    throw new TypeError("canonical JSON does not support unpaired UTF-16 surrogates");
  }
}

function isSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdfff;
}

function isSurrogatePair(code: number, next: number): boolean {
  return isHighSurrogate(code) && isLowSurrogate(next);
}

function isHighSurrogate(code: number): boolean {
  return code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
