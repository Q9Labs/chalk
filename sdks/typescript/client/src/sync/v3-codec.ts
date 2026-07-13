import { Schema } from "effect";
import { SyncV3ClientFrameSchema, SyncV3ServerFrameSchema, encodeSyncFrame, type SyncV3ClientFrame, type SyncV3ServerFrame } from "../generated/sync-v3";

export function encodeV3ClientFrame(frame: unknown): string {
  return encodeSyncFrame(Schema.decodeUnknownSync(SyncV3ClientFrameSchema)(frame));
}

export function decodeV3ServerFrame(wire: string): SyncV3ServerFrame {
  return Schema.decodeUnknownSync(SyncV3ServerFrameSchema)(JSON.parse(wire));
}

export function decodeV3ClientFrame(value: unknown): SyncV3ClientFrame {
  return Schema.decodeUnknownSync(SyncV3ClientFrameSchema)(value);
}
