import { Schema } from "effect";
import { SyncV1ClientFrameSchema, SyncV1ServerFrameSchema, encodeSyncFrame, type SyncV1ClientFrame, type SyncV1ServerFrame } from "../generated/sync";

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
