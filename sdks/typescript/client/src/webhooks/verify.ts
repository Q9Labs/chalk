import { WebhookVerificationError } from "./errors.js";
import { knownWebhookEventNamesV1, type KnownWebhookEventV1 } from "./generated/event-v1.js";
import type { ChalkWebhookEvent, UnknownWebhookEvent } from "./types.js";
import { validateKnownWebhookEventV1, validateWebhookEnvelopeV1 } from "./validate.js";

const DEFAULT_TOLERANCE_SECONDS = 300;
const MAX_HEADER_LENGTH = 4_096;
const MAX_SIGNATURES = 32;
const MAX_SECRETS = 16;
const MAX_BODY_BYTES = 256 * 1_024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const knownNames = new Set<string>(knownWebhookEventNamesV1);

export type VerifyWebhookInput = {
  rawBody: Uint8Array;
  headers: Headers | Record<string, string | string[] | undefined>;
  secrets: readonly string[];
  toleranceSeconds?: number;
  /** Unsafe outside deterministic tests. */
  now?: () => Date;
};

const normalizeHeaderValue = (value: string | string[] | undefined, allowArray: boolean): string | undefined => {
  if (!Array.isArray(value)) return value;
  if (!allowArray || value.length === 0) throw new WebhookVerificationError("malformed_headers");
  return value.join(" ");
};

const getRecordHeader = (headers: Record<string, string | string[] | undefined>, name: string, allowArray: boolean): string | undefined => {
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (entries.length > 1) throw new WebhookVerificationError("malformed_headers");
  return normalizeHeaderValue(entries[0]?.[1], allowArray);
};

const getHeader = (headers: VerifyWebhookInput["headers"], name: string, allowArray = false): string | undefined => {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  return getRecordHeader(headers, name, allowArray);
};

const parseBase64 = (value: string): Uint8Array | undefined => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const decodeSecrets = (secrets: unknown): readonly Uint8Array[] => {
  if (!Array.isArray(secrets) || secrets.length === 0 || secrets.length > MAX_SECRETS) {
    throw new WebhookVerificationError("invalid_secret");
  }
  return secrets.map(decodeSecret);
};

const decodeSecret = (secret: unknown): Uint8Array => {
  if (typeof secret !== "string") throw new WebhookVerificationError("invalid_secret");
  if (!secret.startsWith("whsec_")) throw new WebhookVerificationError("invalid_secret");
  return requireSecretBytes(parseBase64(secret.slice(6)));
};

const requireSecretBytes = (decoded: Uint8Array | undefined): Uint8Array => {
  if (decoded === undefined) throw new WebhookVerificationError("invalid_secret");
  if (decoded.length !== 32) throw new WebhookVerificationError("invalid_secret");
  return decoded;
};

const parseTimestamp = (timestampValue: string): number => {
  if (timestampValue.length > 16 || !/^[0-9]+$/u.test(timestampValue)) throw new WebhookVerificationError("malformed_headers");
  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp)) throw new WebhookVerificationError("malformed_headers");
  return timestamp;
};

const parseSignature = (part: string): Uint8Array => {
  const match = /^v1,([A-Za-z0-9+/]+={0,2})$/u.exec(part);
  if (!match) throw new WebhookVerificationError("malformed_headers");
  return requireSignatureBytes(parseBase64(match[1] ?? ""));
};

const requireSignatureBytes = (bytes: Uint8Array | undefined): Uint8Array => {
  if (bytes === undefined) throw new WebhookVerificationError("malformed_headers");
  if (bytes.length !== 32) throw new WebhookVerificationError("malformed_headers");
  return bytes;
};

const parseSignatures = (signatureValue: string): readonly Uint8Array[] => {
  if (signatureValue.length > MAX_HEADER_LENGTH) throw new WebhookVerificationError("malformed_headers");
  const parts = signatureValue.split(" ");
  if (parts.length === 0 || parts.length > MAX_SIGNATURES) throw new WebhookVerificationError("malformed_headers");
  return parts.map(parseSignature);
};

const requireHeader = (headers: VerifyWebhookInput["headers"], name: string, allowArray = false): string => {
  const value = getHeader(headers, name, allowArray);
  if (value === undefined) throw new WebhookVerificationError("missing_headers");
  return value;
};

const parseHeaders = (headers: VerifyWebhookInput["headers"]) => {
  const id = requireHeader(headers, "webhook-id");
  const timestampValue = requireHeader(headers, "webhook-timestamp");
  const signatureValue = requireHeader(headers, "webhook-signature", true);
  if (id.length === 0 || id.length > 128) throw new WebhookVerificationError("malformed_headers");
  return { id, timestamp: parseTimestamp(timestampValue), timestampValue, signatures: parseSignatures(signatureValue) };
};

const signedPayload = (id: string, timestamp: string, rawBody: Uint8Array): Uint8Array => {
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const payload = new Uint8Array(prefix.length + rawBody.length);
  payload.set(prefix);
  payload.set(rawBody, prefix.length);
  return payload;
};

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

const signatureSetMatches = (expected: Uint8Array, signatures: readonly Uint8Array[]): boolean => {
  let matched = false;
  for (const supplied of signatures) matched = constantTimeEqual(expected, supplied) || matched;
  return matched;
};

const signPayload = async (payload: Uint8Array, secret: Uint8Array): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(payload)));
};

const verifySignature = async (payload: Uint8Array, secrets: readonly Uint8Array[], signatures: readonly Uint8Array[]) => {
  let matched = false;
  for (const secret of secrets) {
    matched = signatureSetMatches(await signPayload(payload, secret), signatures) || matched;
  }
  if (!matched) throw new WebhookVerificationError("invalid_signature");
};

const isFreezable = (value: unknown): value is object => Boolean(value) && typeof value === "object";

const deepFreeze = <Value>(value: Value): Value => {
  if (!isFreezable(value)) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
  return value;
};

const validateTolerance = (tolerance: number): void => {
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) throw new WebhookVerificationError("malformed_headers");
};

const currentSeconds = (now: Date): number => {
  const currentTimeMilliseconds = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(currentTimeMilliseconds)) throw new WebhookVerificationError("stale_timestamp");
  return Math.floor(currentTimeMilliseconds / 1_000);
};

const validateTimestamp = (timestamp: number, tolerance: number, now: Date): void => {
  validateTolerance(tolerance);
  if (Math.abs(currentSeconds(now) - timestamp) > tolerance) throw new WebhookVerificationError("stale_timestamp");
};

const parseBody = (rawBody: Uint8Array): unknown => {
  try {
    return JSON.parse(decoder.decode(rawBody));
  } catch {
    throw new WebhookVerificationError("invalid_json");
  }
};

const invalidApiVersion = (body: unknown): boolean => typeof body === "object" && body !== null && "api_version" in body && body.api_version !== 1;

const assertValidEnvelope: (body: unknown) => asserts body is Record<string, unknown> = (body) => {
  if (validateWebhookEnvelopeV1(body)) return;
  if (invalidApiVersion(body)) throw new WebhookVerificationError("unsupported_api_version");
  throw new WebhookVerificationError("invalid_event_body");
};

const assertEventShape = (body: Record<string, unknown>): void => {
  if (typeof body.event !== "string") throw new WebhookVerificationError("invalid_event_body");
  if (!isEventData(body.data)) throw new WebhookVerificationError("invalid_event_body");
};

const isEventData = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const validateEnvelope: (body: unknown, headerId: string) => asserts body is UnknownWebhookEvent = (body, headerId) => {
  assertValidEnvelope(body);
  if (body.api_version !== 1) throw new WebhookVerificationError("unsupported_api_version");
  if (body.id !== headerId) throw new WebhookVerificationError("identifier_mismatch");
  assertEventShape(body);
};

const validatedEvent = (body: unknown, headerId: string): ChalkWebhookEvent => {
  validateEnvelope(body, headerId);
  if (!knownNames.has(body.event)) return deepFreeze(body);
  if (!validateKnownWebhookEventV1(body)) throw new WebhookVerificationError("invalid_event_body");
  return deepFreeze(body as KnownWebhookEventV1);
};

export const verifyWebhook = async (input: VerifyWebhookInput): Promise<ChalkWebhookEvent> => {
  assertBodySize(input.rawBody);
  const parsedHeaders = parseHeaders(input.headers);
  validateTimestamp(parsedHeaders.timestamp, input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, input.now?.() ?? new Date());
  const secrets = decodeSecrets(input.secrets);
  await verifySignature(signedPayload(parsedHeaders.id, parsedHeaders.timestampValue, input.rawBody), secrets, parsedHeaders.signatures);
  return validatedEvent(parseBody(input.rawBody), parsedHeaders.id);
};

function assertBodySize(rawBody: Uint8Array): void {
  if (rawBody.byteLength > MAX_BODY_BYTES) throw new WebhookVerificationError("invalid_event_body");
}
