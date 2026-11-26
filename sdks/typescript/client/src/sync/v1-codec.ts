import { annotationServerFrame } from "../screen-annotation/codec";
import { presentingServerFrame } from "../presenting/codec";
import { V1ReplicaError } from "./v1-reducer";
import { Schema } from "effect";
import { SyncProtocolLimits, SyncV1ClientFrameSchema, SyncV1ServerFrameSchema, encodeSyncFrame, type SyncV1ClientFrame, type SyncV1ServerFrame } from "../generated/sync";

export function encodeV1ClientFrame(frame: unknown): string {
  return encodeSyncFrame(Schema.decodeUnknownSync(SyncV1ClientFrameSchema)(frame));
}

export function decodeV1ServerFrame(wire: string): SyncV1ServerFrame {
  return decodeV1ServerValue(JSON.parse(wire));
}

export function decodeV1ServerValue(value: unknown): SyncV1ServerFrame {
  return Schema.decodeUnknownSync(SyncV1ServerFrameSchema)(value);
}

export function decodeV1ClientFrame(value: unknown): SyncV1ClientFrame {
  return Schema.decodeUnknownSync(SyncV1ClientFrameSchema)(value);
}

const encoder = new TextEncoder();

export function decodeInboundV1Frame(data: unknown) {
  if (typeof data !== "string") throw new V1ReplicaError("invalid inbound frame size");
  const size = encoder.encode(data).byteLength;
  if (size > SyncProtocolLimits.snapshotEncodedBytes) throw new V1ReplicaError("invalid inbound frame size");
  const value: unknown = JSON.parse(data);
  const annotation = annotationServerFrame(value, size);
  if (annotation) return { kind: "annotation" as const, value: annotation };
  const presenting = presentingServerFrame(value);
  return presenting ? { kind: "presenting" as const, value: presenting } : { kind: "base" as const, value: decodeV1ServerValue(value) };
}
