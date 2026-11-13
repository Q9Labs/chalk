import { Schema } from "effect";
import { WhiteboardV1ClientFrameSchema, WhiteboardV1ServerFrameSchema, encodeWhiteboardV1Frame, type WhiteboardV1Element, type WhiteboardV1ServerFrame } from "../generated/whiteboard-v1";
import type { ChalkWhiteboardV1Element } from "./types";

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

export function elementToFrame(element: ChalkWhiteboardV1Element): WhiteboardV1Element {
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    version_nonce: element.versionNonce,
    index: element.index,
    is_deleted: element.isDeleted,
    payload: element.payload,
  };
}

export function elementFromFrame(element: WhiteboardV1Element): ChalkWhiteboardV1Element {
  return {
    id: element.id,
    type: element.type,
    version: element.version,
    versionNonce: element.version_nonce,
    index: element.index,
    isDeleted: element.is_deleted,
    payload: element.payload,
  };
}
