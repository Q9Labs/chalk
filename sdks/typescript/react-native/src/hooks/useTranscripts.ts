import type { Transcript } from "../internal/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useSession } from "../context/chalk-native-provider";
import { useConnection } from "./useConnection";
import { createTranscriptStore, type TranscriptRoom } from "./transcript-store";

export interface UseTranscriptsReturn {
  transcripts: Transcript[];
  isAvailable: boolean;
  clearTranscripts: () => void;
}

export function useTranscripts(): UseTranscriptsReturn {
  const session = useSession();
  const { isConnected } = useConnection();
  const room: TranscriptRoom | null = session.room.getRoom() ?? null;
  const store = useMemo(() => createTranscriptStore(), [session]);
  store.setSource(room, isConnected);
  const subscribe = useCallback((listener: () => void) => store.subscribeToSource(listener, room, isConnected), [store, room, isConnected]);
  const { transcripts, isAvailable } = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot);
  const clearTranscripts = useCallback(() => store.clear(), [store]);

  return useMemo(
    () => ({
      transcripts,
      isAvailable,
      clearTranscripts,
    }),
    [transcripts, isAvailable, clearTranscripts],
  );
}
