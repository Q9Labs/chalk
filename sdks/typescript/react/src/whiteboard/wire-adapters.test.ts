import type { ChalkWhiteboardV1Element, ChalkWhiteboardV1Event } from "@q9labsai/chalk-client";
import type { WhiteboardWireElement } from "@q9labsai/chalk-whiteboard";
import { describe, expect, it } from "vitest";

import { fromWhiteboardWireElement, toWhiteboardCollaborationEvent, toWhiteboardWireElement } from "./wire-adapters";

const wireElement: WhiteboardWireElement = {
  id: "element-1",
  type: "text",
  version: 3,
  version_nonce: 8,
  index: "a1",
  is_deleted: false,
  payload: { text: "Hello", x: 12, tags: ["space"] },
};

const clientElement: ChalkWhiteboardV1Element = {
  id: "element-1",
  type: "text",
  version: 3,
  versionNonce: 8,
  index: "a1",
  isDeleted: false,
  payload: { text: "Hello", x: 12, tags: ["space"] },
};

describe("whiteboard wire adapters", () => {
  it("round-trips snake_case wire fields through the client shape", () => {
    expect(toWhiteboardWireElement(fromWhiteboardWireElement(wireElement))).toEqual(wireElement);
    expect(fromWhiteboardWireElement(toWhiteboardWireElement(clientElement))).toEqual(clientElement);
  });

  it("maps snapshot and update elements while preserving event metadata", () => {
    const events: readonly ChalkWhiteboardV1Event[] = [
      { type: "snapshot", sceneId: "scene-1", revision: "4", elements: [clientElement], appState: { viewBackgroundColor: "#fff" } },
      { type: "update", sceneId: "scene-1", revision: "5", elements: [clientElement] },
    ];

    expect(events.map(toWhiteboardCollaborationEvent)).toEqual([
      { type: "snapshot", sceneId: "scene-1", revision: "4", elements: [wireElement], appState: { viewBackgroundColor: "#fff" } },
      { type: "update", sceneId: "scene-1", revision: "5", elements: [wireElement] },
    ]);
  });

  it("passes cursor events through with their presence coordinates", () => {
    const cursor: ChalkWhiteboardV1Event = {
      type: "cursor",
      participantId: "participant-1",
      displayName: "Grace",
      x: 24,
      y: 48,
      occurredAt: "2026-08-01T08:00:00.000Z",
    };

    expect(toWhiteboardCollaborationEvent(cursor)).toEqual(cursor);
  });
});
