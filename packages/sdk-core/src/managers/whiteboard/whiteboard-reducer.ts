import type { WhiteboardState } from "../whiteboard-manager";
import type { WhiteboardCursor } from "../../types/entities/whiteboard";

type WhiteboardElement = {
  id: string;
  version?: number;
  isDeleted?: boolean;
};

interface ReduceRemoteWhiteboardUpdateInput {
  state: WhiteboardState;
  sceneId: string;
  syncAll: boolean;
  elements: readonly unknown[];
  files?: Readonly<Record<string, unknown>>;
  seq: number;
}

interface ReduceLocalWhiteboardUpdateInput {
  state: WhiteboardState;
  elements: readonly unknown[];
  files: Readonly<Record<string, unknown>> | null;
  seq: number;
}

const castElements = (elements: readonly unknown[]): WhiteboardElement[] => elements as WhiteboardElement[];

export const mergeWhiteboardElements = (existing: readonly unknown[], incoming: readonly unknown[]): unknown[] => {
  const elementMap = new Map(castElements(existing).map((element) => [element.id, element]));

  for (const element of castElements(incoming)) {
    if (element.isDeleted) {
      elementMap.delete(element.id);
      continue;
    }

    const current = elementMap.get(element.id);
    if (!current || (element.version ?? 0) >= (current.version ?? 0)) {
      elementMap.set(element.id, element);
    }
  }

  return Array.from(elementMap.values());
};

export const reduceWhiteboardPermissionSync = (canDraw: boolean): Pick<WhiteboardState, "canDraw"> => ({ canDraw });

export const reduceRemoteWhiteboardUpdate = ({ state, sceneId, syncAll, elements, files, seq }: ReduceRemoteWhiteboardUpdateInput): Pick<WhiteboardState, "sceneId" | "elements" | "files" | "lastSeq"> => ({
  sceneId,
  elements: syncAll ? [...elements] : mergeWhiteboardElements(state.elements, elements),
  files: { ...state.files, ...(files ?? {}) },
  lastSeq: Math.max(state.lastSeq, seq),
});

export const reduceWhiteboardSnapshot = ({ sceneId, elements, files, lastSeq }: { sceneId: string; elements: readonly unknown[]; files: Readonly<Record<string, unknown>>; lastSeq: number }): Pick<WhiteboardState, "sceneId" | "elements" | "files" | "lastSeq"> => ({
  sceneId,
  elements: [...elements],
  files: { ...files },
  lastSeq,
});

export const reduceWhiteboardCursorState = (cursors: ReadonlyMap<string, WhiteboardCursor>): Pick<WhiteboardState, "cursors"> => ({
  cursors: Array.from(cursors.values()),
});

export const reduceWhiteboardOpened = (openParticipants: ReadonlySet<string>): Pick<WhiteboardState, "isOpen" | "openParticipants"> => ({
  isOpen: true,
  openParticipants: Array.from(openParticipants),
});

export const reduceWhiteboardClosed = ({ openParticipants, cursors }: { openParticipants: ReadonlySet<string>; cursors: ReadonlyMap<string, WhiteboardCursor> }): Pick<WhiteboardState, "isOpen" | "openParticipants" | "cursors"> => ({
  isOpen: false,
  openParticipants: Array.from(openParticipants),
  cursors: Array.from(cursors.values()),
});

export const reduceWhiteboardParticipantLeft = ({ openParticipants, cursors }: { openParticipants: ReadonlySet<string>; cursors: ReadonlyMap<string, WhiteboardCursor> }): Pick<WhiteboardState, "openParticipants" | "cursors"> => ({
  openParticipants: Array.from(openParticipants),
  cursors: Array.from(cursors.values()),
});

export const reduceLocalWhiteboardUpdate = ({ state, elements, files, seq }: ReduceLocalWhiteboardUpdateInput): Pick<WhiteboardState, "elements" | "files" | "lastSeq"> => ({
  elements: mergeWhiteboardElements(state.elements, elements),
  files: { ...state.files, ...(files ?? {}) },
  lastSeq: Math.max(state.lastSeq, seq),
});

export const reduceWhiteboardClear = (): Pick<WhiteboardState, "sceneId" | "elements" | "files" | "lastSeq"> => ({
  sceneId: undefined,
  elements: [],
  files: {},
  lastSeq: 0,
});
