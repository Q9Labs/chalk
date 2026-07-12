import type { RecordingState } from "../internal/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useSession } from "../context/chalk-native-provider";
import { createRecordingDurationStore } from "./recording-duration-store";
import { useManagerState } from "./external-store";

export interface UseRecordingReturn {
  isRecording: boolean;
  isStarting: boolean;
  isStopping: boolean;
  recordingId: string | null;
  durationSeconds: number;
  start: () => Promise<string>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
}

export function useRecording(): UseRecordingReturn {
  const session = useSession();
  const { recording } = session;
  const state = useManagerState<RecordingState>(recording);
  const durationStore = useMemo(() => createRecordingDurationStore(recording), [recording]);
  const durationSeconds = useSyncExternalStore(durationStore.subscribe, durationStore.getSnapshot, durationStore.getSnapshot);

  const start = useCallback(() => recording.start(), [recording]);
  const stop = useCallback(() => recording.stop(), [recording]);
  const toggle = useCallback(async () => {
    if (state.isRecording) {
      await recording.stop();
      return;
    }

    await recording.start();
  }, [recording, state.isRecording]);

  return useMemo(
    () => ({
      isRecording: state.isRecording,
      isStarting: state.isStarting,
      isStopping: state.isStopping,
      recordingId: state.recordingId,
      durationSeconds,
      start,
      stop,
      toggle,
    }),
    [state, durationSeconds, start, stop, toggle],
  );
}
