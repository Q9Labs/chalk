import type { WhiteboardCursor, WhiteboardSnapshot, WhiteboardUpdate } from "@q9labs/chalk-core";
import type { MutableRefObject } from "react";

export interface ExcalidrawElement {
  id: string;
  version: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export type BinaryFiles = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CollabEngine = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SyncEngine = any;

export interface WhiteboardRoomLike {
  sendWhiteboardUpdateV2: (payload: { sceneId?: string; syncAll?: boolean; elements: readonly unknown[]; seq?: number }) => void;
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
  syncEngineRef: MutableRefObject<SyncEngine | null>;
  collabEngineRef: MutableRefObject<CollabEngine | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  excalidrawRef: MutableRefObject<any>;
  elementsRef: MutableRefObject<readonly ExcalidrawElement[]>;
  filesRef: MutableRefObject<Record<string, unknown>>;
}

export interface WhiteboardSyncPayload {
  useV2: boolean;
  canDraw: boolean;
  requestSync: () => void;
  latestUpdate: WhiteboardUpdate | null;
  latestSnapshot: WhiteboardSnapshot | null;
  cursors: readonly WhiteboardCursor[];
  session: WhiteboardSessionLike;
  refs: WhiteboardEngineRefs;
}
