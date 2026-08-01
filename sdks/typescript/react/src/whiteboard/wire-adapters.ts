import type { ChalkWhiteboardV1Element, ChalkWhiteboardV1Event } from "@q9labsai/chalk-client";
import type { WhiteboardCollaborationEvent, WhiteboardWireElement } from "@q9labsai/chalk-whiteboard";

export function fromWhiteboardWireElement(element: WhiteboardWireElement): ChalkWhiteboardV1Element {
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

export function toWhiteboardWireElement(element: ChalkWhiteboardV1Element): WhiteboardWireElement {
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

export function toWhiteboardCollaborationEvent(event: ChalkWhiteboardV1Event): WhiteboardCollaborationEvent {
  if (event.type === "snapshot" || event.type === "update") {
    return {
      ...event,
      elements: event.elements.map(toWhiteboardWireElement),
    };
  }
  return event;
}
