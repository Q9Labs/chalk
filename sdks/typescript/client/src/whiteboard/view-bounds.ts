import { WhiteboardV1ProtocolMetadata } from "../generated/whiteboard-v1";

/** Bounds for shared camera rectangles and retained people. */
export const ChalkWhiteboardViewBounds = {
  maxCoordinate: WhiteboardV1ProtocolMetadata.frames.view.maxCoordinate,
  maxExtent: WhiteboardV1ProtocolMetadata.frames.view.maxExtent,
  maxPeople: WhiteboardV1ProtocolMetadata.limits.viewPeopleMaxItems,
};
