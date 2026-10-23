import { Schema } from "effect";
import { WhiteboardV1ClientFrameSchema, WhiteboardV1ServerFrameSchema, encodeWhiteboardV1Frame, type WhiteboardV1ServerFrame } from "../generated/whiteboard-v1";

export function encodeWhiteboardV1ClientFrame(frame: unknown): string {
  return encodeWhiteboardV1Frame(Schema.decodeUnknownSync(WhiteboardV1ClientFrameSchema)(frame));
}

/** Negotiated control frames belong to the connection, not the public 5.1 frame union. */
export function decodeWhiteboardV1ServerFrame(wire: string): Exclude<WhiteboardV1ServerFrame, { readonly type: "view_ack" | "draw_access" }> {
  const frame = decodeWhiteboardV1WireFrame(wire);
  if (frame.type === "view_ack" || frame.type === "draw_access") throw new Error("Negotiated whiteboard control frame");
  return frame;
}

export function decodeWhiteboardV1WireFrame(wire: string): WhiteboardV1ServerFrame {
  return Schema.decodeUnknownSync(WhiteboardV1ServerFrameSchema)(JSON.parse(wire));
}
