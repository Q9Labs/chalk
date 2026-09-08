export interface RecordingMediaSourceIdentityInput {
  readonly recordingId: string;
  readonly participantId: string;
  readonly participantGeneration: number;
  readonly kind: "microphone" | "camera" | "screen_share";
  readonly trackId: string;
  readonly epoch: number;
}

const SOURCE_ID_DOMAIN = "recording_presentation_source.v1";
const SOURCE_ID_PREFIX = "rps_";
const SOURCE_KINDS = new Set(["microphone", "camera", "screen_share"]);
const encoder = new TextEncoder();

const encodePart = (value: string): Uint8Array => {
  const bytes = encoder.encode(value);
  const framed = new Uint8Array(4 + bytes.byteLength);
  new DataView(framed.buffer).setUint32(0, bytes.byteLength, false);
  framed.set(bytes, 4);
  return framed;
};

const identityMaterial = (input: RecordingMediaSourceIdentityInput): Uint8Array => {
  if ([input.recordingId, input.participantId, input.trackId].some((value) => value.length === 0)) invalidIdentity();
  if (!isPositiveInteger(input.participantGeneration)) invalidIdentity();
  if (!isPositiveInteger(input.epoch)) invalidIdentity();
  if (!SOURCE_KINDS.has(input.kind)) invalidIdentity();

  const parts = [SOURCE_ID_DOMAIN, input.recordingId, input.participantId, String(input.participantGeneration), input.kind, input.trackId, String(input.epoch)].map(encodePart);
  const material = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    material.set(part, offset);
    offset += part.byteLength;
  }
  return material;
};

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

const invalidIdentity = (): never => {
  throw new TypeError("invalid recording media source identity");
};

export const deriveRecordingMediaSourceId = async (input: RecordingMediaSourceIdentityInput): Promise<string> => {
  const material = identityMaterial(input);
  const digestInput = new ArrayBuffer(material.byteLength);
  new Uint8Array(digestInput).set(material);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", digestInput));
  return SOURCE_ID_PREFIX + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
