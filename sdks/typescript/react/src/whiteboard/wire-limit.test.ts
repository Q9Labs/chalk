import { expect, it } from "vitest";
import { WhiteboardV1ProtocolLimits } from "@q9labsai/chalk-client";
import { WHITEBOARD_ELEMENT_PAYLOAD_LIMIT } from "@q9labsai/chalk-whiteboard";

it("keeps the standalone engine payload limit equal to the whiteboard-v1 contract", () => {
  expect(WHITEBOARD_ELEMENT_PAYLOAD_LIMIT).toBe(WhiteboardV1ProtocolLimits.elementPayloadEncodedBytes);
});
