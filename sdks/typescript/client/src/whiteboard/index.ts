import { WhiteboardV1ProtocolMetadata } from "../generated/whiteboard-v1";

/** Bounds for camera rectangles shared with other participants. */
export const ChalkWhiteboardViewBounds = {
  maxCoordinate: WhiteboardV1ProtocolMetadata.frames.view.maxCoordinate,
  maxExtent: WhiteboardV1ProtocolMetadata.frames.view.maxExtent,
};

export { createChalkWhiteboardV1FileDownloadTransport, type ChalkWhiteboardV1FileDownloadTransportOptions } from "./file-download-transport";
export * from "./types";
export { ChalkWhiteboardV1Client } from "./v1-client";
export { decodeWhiteboardV1ServerFrame, encodeWhiteboardV1ClientFrame } from "./v1-codec";
export { createChalkWhiteboardV1Client, type CreateChalkWhiteboardV1ClientOptions } from "./v1-create";
export { InMemoryChalkWhiteboardV1PendingOperationStore } from "./v1-persistence";
