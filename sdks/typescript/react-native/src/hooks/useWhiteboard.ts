import type { ChalkWhiteboardV1Event, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useState } from "react";

import { useChalkSession } from "../context/chalk-provider";
import { useChalkSnapshot } from "./useChalkSnapshot";

export interface UseWhiteboardReturn {
  readonly transport: ChalkWhiteboardV1Transport | null;
  readonly status: ReturnType<typeof useChalkSnapshot>["whiteboard"]["status"];
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly latestEvent: ChalkWhiteboardV1Event | null;
  readonly requestSnapshot: () => Promise<void>;
  readonly clear: () => Promise<void>;
}

export function useWhiteboard(): UseWhiteboardReturn {
  const session = useChalkSession();
  const snapshot = useChalkSnapshot();
  const [latestEvent, setLatestEvent] = useState<ChalkWhiteboardV1Event | null>(null);

  useEffect(() => session.whiteboard?.subscribe(setLatestEvent), [session.whiteboard]);
  const requestSnapshot = useCallback(async () => session.whiteboard?.requestSnapshot(), [session.whiteboard]);
  const clear = useCallback(async () => {
    await session.whiteboard?.clear();
  }, [session.whiteboard]);

  return {
    transport: session.whiteboard,
    status: snapshot.whiteboard.status,
    canDraw: snapshot.whiteboard.canDraw,
    canClear: snapshot.whiteboard.canClear,
    latestEvent,
    requestSnapshot,
    clear,
  };
}
