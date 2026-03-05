import { useEffect, useState } from "react";

import { CURSOR_STALE_MS, getCursorColor } from "./constants";
import type { ExcalidrawElement, WhiteboardSyncPayload } from "./types";

export function useWhiteboardSync({ useV2, canDraw, requestSync, latestUpdate, latestSnapshot, cursors, session, refs }: WhiteboardSyncPayload) {
  const [cursorTick, setCursorTick] = useState(0);

  useEffect(() => {
    requestSync();
  }, [requestSync]);

  useEffect(() => {
    if (useV2) return;
    const interval = setInterval(() => {
      setCursorTick((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [useV2]);

  useEffect(() => {
    if (!useV2) return;
    refs.collabEngineRef.current?.setCanDraw?.(canDraw);
  }, [canDraw, refs.collabEngineRef, useV2]);

  useEffect(() => {
    if (!latestUpdate) return;
    if (useV2) {
      refs.collabEngineRef.current?.handleRemoteData({
        sceneId: latestUpdate.sceneId,
        syncAll: latestUpdate.syncAll,
        elements: latestUpdate.elements as unknown[],
      });
      return;
    }

    if (!refs.syncEngineRef.current || !refs.excalidrawRef.current) return;
    const merged = refs.syncEngineRef.current.applyRemoteUpdate(refs.elementsRef.current, {
      elements: latestUpdate.elements as ExcalidrawElement[],
      seq: latestUpdate.seq,
      participantId: latestUpdate.participantId,
    });

    if (latestUpdate.files) {
      refs.filesRef.current = { ...refs.filesRef.current, ...latestUpdate.files };
    }

    refs.elementsRef.current = merged;
    refs.excalidrawRef.current.updateScene({
      elements: merged,
      files: refs.filesRef.current,
    });
  }, [latestUpdate, refs.collabEngineRef, refs.elementsRef, refs.excalidrawRef, refs.filesRef, refs.syncEngineRef, useV2]);

  useEffect(() => {
    if (!latestSnapshot) return;
    if (useV2) {
      refs.collabEngineRef.current?.handleRemoteSnapshot({
        sceneId: latestSnapshot.sceneId,
        elements: latestSnapshot.elements as unknown[],
      });
      return;
    }

    if (!refs.excalidrawRef.current) return;
    refs.elementsRef.current = latestSnapshot.elements as ExcalidrawElement[];
    refs.filesRef.current = latestSnapshot.files ?? {};
    refs.syncEngineRef.current?.loadSnapshot(latestSnapshot.elements as ExcalidrawElement[], latestSnapshot.lastSeq);
    refs.excalidrawRef.current.updateScene({
      elements: latestSnapshot.elements,
      files: latestSnapshot.files,
      appState: latestSnapshot.appState,
    });
  }, [latestSnapshot, refs.collabEngineRef, refs.elementsRef, refs.excalidrawRef, refs.filesRef, refs.syncEngineRef, useV2]);

  useEffect(() => {
    if (useV2) {
      return session.whiteboard.on("cursor", (cursor) => {
        refs.collabEngineRef.current?.handleRemoteCursor({
          participantId: cursor.participantId,
          displayName: cursor.displayName,
          x: cursor.x,
          y: cursor.y,
          timestamp: cursor.timestamp instanceof Date ? cursor.timestamp : new Date(cursor.timestamp as unknown as string),
        });
      });
    }

    if (!refs.excalidrawRef.current) return;
    const now = Date.now();
    const collaborators = new Map();

    for (const cursor of cursors) {
      const timestamp = cursor.timestamp instanceof Date ? cursor.timestamp.getTime() : new Date(cursor.timestamp as unknown as string).getTime();
      if (now - timestamp > CURSOR_STALE_MS) continue;

      collaborators.set(cursor.participantId, {
        pointer: {
          x: cursor.x,
          y: cursor.y,
          tool: "pointer",
          renderCursor: true,
        },
        username: cursor.displayName,
        color: getCursorColor(cursor.participantId),
        id: cursor.participantId,
        socketId: cursor.participantId,
      });
    }

    refs.excalidrawRef.current.updateScene({ collaborators });
  }, [cursorTick, cursors, refs.collabEngineRef, refs.excalidrawRef, session, useV2]);
}
