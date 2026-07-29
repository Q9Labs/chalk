import { Schema } from "effect";
import { WhiteboardV1ClientFrameSchema, WhiteboardV1ServerFrameSchema, encodeWhiteboardV1Frame, type WhiteboardV1ClientFrame, type WhiteboardV1ServerFrame } from "../generated/whiteboard-v1";

export function encodeWhiteboardV1ClientFrame(frame: unknown): string {
  return encodeWhiteboardV1Frame(Schema.decodeUnknownSync(WhiteboardV1ClientFrameSchema)(frame));
}

export function decodeWhiteboardV1ServerFrame(wire: string): WhiteboardV1ServerFrame {
  return Schema.decodeUnknownSync(WhiteboardV1ServerFrameSchema)(JSON.parse(wire));
}

export function decodeWhiteboardV1ClientFrame(value: unknown): WhiteboardV1ClientFrame {
  return Schema.decodeUnknownSync(WhiteboardV1ClientFrameSchema)(value);
}
