import type { WhiteboardCursor, WhiteboardSnapshot, WhiteboardState, WhiteboardUpdate } from "../internal/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

export interface UseWhiteboardReturn {
  isOpen: boolean;
  canDraw: boolean;
  elements: readonly unknown[];
  cursors: readonly WhiteboardCursor[];
  lastSeq: number;
  openParticipants: readonly string[];
  latestUpdate: WhiteboardUpdate | null;
  latestSnapshot: WhiteboardSnapshot | null;
  open: () => void;
  close: () => void;
  toggle: () => void;
  sendUpdate: (elements: unknown[], files?: Record<string, unknown>, seq?: number) => void;
  sendCursor: (x: number, y: number) => void;
  requestSync: () => void;
  clear: () => void;
  grantPermission: (participantId: string) => void;
  revokePermission: (participantId: string) => void;
}

export function useWhiteboard(): UseWhiteboardReturn {
  const session = useSession();
  const { whiteboard } = session;
  const [state, setState] = useState<WhiteboardState>(() => whiteboard.getState());
  const [latestUpdate, setLatestUpdate] = useState<WhiteboardUpdate | null>(null);
  const [latestSnapshot, setLatestSnapshot] = useState<WhiteboardSnapshot | null>(null);

  useEffect(() => whiteboard.subscribe(setState), [whiteboard]);
  useEffect(() => whiteboard.on("update", (update: WhiteboardUpdate) => setLatestUpdate(update)), [whiteboard]);
  useEffect(() => whiteboard.on("snapshot", (snapshot: WhiteboardSnapshot) => setLatestSnapshot(snapshot)), [whiteboard]);

  const open = useCallback(() => whiteboard.open(), [whiteboard]);
  const close = useCallback(() => whiteboard.close(), [whiteboard]);
  const toggle = useCallback(() => {
    if (state.isOpen) {
      whiteboard.close();
      return;
    }

    whiteboard.open();
  }, [state.isOpen, whiteboard]);
  const sendUpdate = useCallback((elements: unknown[], files?: Record<string, unknown>, seq?: number) => whiteboard.sendUpdate(elements, files, seq), [whiteboard]);
  const sendCursor = useCallback((x: number, y: number) => whiteboard.sendCursor(x, y), [whiteboard]);
  const requestSync = useCallback(() => whiteboard.requestSync(), [whiteboard]);
  const clear = useCallback(() => whiteboard.clear(), [whiteboard]);
  const grantPermission = useCallback((participantId: string) => whiteboard.grantPermission(participantId), [whiteboard]);
  const revokePermission = useCallback((participantId: string) => whiteboard.revokePermission(participantId), [whiteboard]);

  return useMemo(
    () => ({
      isOpen: state.isOpen,
      canDraw: state.canDraw,
      elements: state.elements,
      cursors: state.cursors,
      lastSeq: state.lastSeq,
      openParticipants: state.openParticipants,
      latestUpdate,
      latestSnapshot,
      open,
      close,
      toggle,
      sendUpdate,
      sendCursor,
      requestSync,
      clear,
      grantPermission,
      revokePermission,
    }),
    [state, latestUpdate, latestSnapshot, open, close, toggle, sendUpdate, sendCursor, requestSync, clear, grantPermission, revokePermission],
  );
}
