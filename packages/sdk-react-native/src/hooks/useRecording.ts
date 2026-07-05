import type { RecordingState } from "../internal/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

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
  const [state, setState] = useState<RecordingState>(() => recording.getState());
  const [durationSeconds, setDurationSeconds] = useState(0);

  useEffect(() => recording.subscribe(setState), [recording]);

  useEffect(() => {
    if (!state.isRecording) {
      setDurationSeconds(0);
      return;
    }

    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      setDurationSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => clearInterval(intervalId);
  }, [state.isRecording]);

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
