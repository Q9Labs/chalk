/**
 * useScreenAnnotations - Screen annotations from ScreenAnnotationsManager
 */

import type {
  AnnotationAccessMode,
  ScreenAnnotationItem,
  ScreenAnnotationsState,
} from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseScreenAnnotationsReturn {
  isOpen: boolean;
  isSessionActive: boolean;
  canDraw: boolean;
  shareSessionId: string | null;
  sharerParticipantId: string | null;
  accessMode: AnnotationAccessMode;
  items: readonly ScreenAnnotationItem[];
  cursors: ScreenAnnotationsState["cursors"];
  lastSeq: number;
  open: () => void;
  close: () => void;
  toggle: () => void;
  replaceItems: (items: ScreenAnnotationItem[]) => void;
  clear: () => void;
  sendCursor: (x: number, y: number, tool: import("@q9labs/chalk-core").ScreenAnnotationTool) => void;
  requestSync: () => void;
  setAccessMode: (accessMode: AnnotationAccessMode) => void;
}

export function useScreenAnnotations(): UseScreenAnnotationsReturn {
  const session = useSession();
  const { annotations } = session;

  const [state, setState] = useState<ScreenAnnotationsState>(() =>
    annotations.getState(),
  );

  useEffect(() => annotations.subscribe(setState), [annotations]);

  const open = useCallback(() => annotations.open(), [annotations]);
  const close = useCallback(() => annotations.close(), [annotations]);
  const toggle = useCallback(() => annotations.toggle(), [annotations]);
  const replaceItems = useCallback(
    (items: ScreenAnnotationItem[]) => annotations.replaceItems(items),
    [annotations],
  );
  const clear = useCallback(() => annotations.clear(), [annotations]);
  const sendCursor = useCallback(
    (x: number, y: number, tool: import("@q9labs/chalk-core").ScreenAnnotationTool) =>
      annotations.sendCursor(x, y, tool),
    [annotations],
  );
  const requestSync = useCallback(() => annotations.requestSync(), [annotations]);
  const setAccessMode = useCallback(
    (accessMode: AnnotationAccessMode) => annotations.setAccessMode(accessMode),
    [annotations],
  );

  return useMemo(
    () => ({
      isOpen: state.isOpen,
      isSessionActive: state.isSessionActive,
      canDraw: state.canDraw,
      shareSessionId: state.shareSessionId,
      sharerParticipantId: state.sharerParticipantId,
      accessMode: state.accessMode,
      items: state.items,
      cursors: state.cursors,
      lastSeq: state.lastSeq,
      open,
      close,
      toggle,
      replaceItems,
      clear,
      sendCursor,
      requestSync,
      setAccessMode,
    }),
    [state, open, close, toggle, replaceItems, clear, sendCursor, requestSync, setAccessMode],
  );
}
