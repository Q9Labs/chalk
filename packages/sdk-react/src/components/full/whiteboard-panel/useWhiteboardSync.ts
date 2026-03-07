import { useEffect } from "react";
import type { AppState } from "@q9labs/chalk-whiteboard/collab";

import type { WhiteboardSyncPayload } from "./types";

export function useWhiteboardSync({ canDraw, requestSync, latestUpdate, latestSnapshot, session, refs }: WhiteboardSyncPayload) {
  useEffect(() => {
    requestSync();
  }, [requestSync]);

  useEffect(() => {
    refs.collabEngineRef.current?.setCanDraw?.(canDraw);
  }, [canDraw, refs.collabEngineRef]);

  useEffect(() => {
    if (!latestUpdate) return;
    refs.collabEngineRef.current?.handleRemoteData({
      sceneId: latestUpdate.sceneId,
      syncAll: latestUpdate.syncAll,
      elements: latestUpdate.elements as unknown[],
    });
  }, [latestUpdate, refs.collabEngineRef]);

  useEffect(() => {
    if (!latestSnapshot) return;
    refs.collabEngineRef.current?.handleRemoteSnapshot({
      sceneId: latestSnapshot.sceneId,
      elements: latestSnapshot.elements,
      appState: latestSnapshot.appState as unknown as AppState | undefined,
    });
  }, [latestSnapshot, refs.collabEngineRef]);

  useEffect(() => {
    return session.whiteboard.on("cursor", (cursor) => {
      refs.collabEngineRef.current?.handleRemoteCursor({
        participantId: cursor.participantId,
        displayName: cursor.displayName,
        x: cursor.x,
        y: cursor.y,
        timestamp: cursor.timestamp instanceof Date ? cursor.timestamp : new Date(cursor.timestamp as unknown as string),
      });
    });
  }, [refs.collabEngineRef, session]);
}
