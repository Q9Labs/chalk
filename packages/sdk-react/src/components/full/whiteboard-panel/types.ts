export interface WhiteboardCursor {
  participantId: string;
  x: number;
  y: number;
  [key: string]: unknown;
}
export interface WhiteboardSnapshot {
  elements?: readonly unknown[];
  [key: string]: unknown;
}
export interface WhiteboardUpdate {
  elements?: readonly unknown[];
  [key: string]: unknown;
}
export type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawCollabEngine } from "@q9labs/chalk-whiteboard/collab";
import type { MutableRefObject } from "react";

export type CollabEngine = ExcalidrawCollabEngine;

export interface WhiteboardRoomLike {
  sendWhiteboardUpdateV2: (payload: { sceneId: string; syncAll: boolean; elements: readonly unknown[]; seq?: number }) => void;
  sendWhiteboardCursor: (x: number, y: number) => void;
  requestWhiteboardSync: () => void;
  clearWhiteboard: () => void;
}

export interface WhiteboardSessionLike {
  room: {
    getRoom: () => WhiteboardRoomLike | null;
  };
  whiteboard: {
    on: (event: "cursor", listener: (cursor: WhiteboardCursor) => void) => () => void;
  };
  whiteboardPresignUpload: (fileId: string, mimeType: string) => Promise<{ uploadUrl: string }>;
  whiteboardPresignDownload: (fileId: string) => Promise<{ downloadUrl: string }>;
}

export interface WhiteboardEngineRefs {
  collabEngineRef: MutableRefObject<CollabEngine | null>;
}

export interface WhiteboardSyncPayload {
  canDraw: boolean;
  requestSync: () => void;
  latestUpdate: WhiteboardUpdate | null;
  latestSnapshot: WhiteboardSnapshot | null;
  session: WhiteboardSessionLike;
  refs: WhiteboardEngineRefs;
}
