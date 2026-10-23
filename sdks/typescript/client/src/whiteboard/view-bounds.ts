import { WhiteboardV1ProtocolMetadata } from "../generated/whiteboard-v1";

/** Bounds for shared camera rectangles. */
export const ChalkWhiteboardViewBounds = {
  maxCoordinate: WhiteboardV1ProtocolMetadata.frames.view.maxCoordinate,
  maxExtent: WhiteboardV1ProtocolMetadata.frames.view.maxExtent,
};
