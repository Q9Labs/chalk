import type { RecordingState } from "../internal/core";
import type { ExternalStateManager, ExternalStore } from "./external-store";

export function createRecordingDurationStore(recording: ExternalStateManager<RecordingState>): ExternalStore<number> {
  let snapshot = 0;
  let wasRecording = false;
  let startedAt: number | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let unsubscribeRecording: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    listeners.forEach((listener) => listener());
  };

  const stopTimer = (): void => {
    if (intervalId === null) return;
    clearInterval(intervalId);
    intervalId = null;
  };

  const updateDuration = (): void => {
    if (startedAt === null) return;
    const nextDuration = Math.floor((Date.now() - startedAt) / 1000);
    if (nextDuration === snapshot) return;
    snapshot = nextDuration;
    notify();
  };

  const startTimer = (): void => {
    startedAt = Date.now();
    snapshot = 0;
    stopTimer();
    intervalId = setInterval(updateDuration, 1000);
  };

  const updateFromState = (state: RecordingState): void => {
    if (state.isRecording === wasRecording) return;
    wasRecording = state.isRecording;

    if (state.isRecording) {
      startTimer();
      return;
    }

    startedAt = null;
    stopTimer();
    if (snapshot === 0) return;
    snapshot = 0;
    notify();
  };

  const start = (): void => {
    const state = recording.getState();
    wasRecording = state.isRecording;
    if (state.isRecording) startTimer();
    unsubscribeRecording = recording.subscribe(updateFromState);
  };

  const stop = (): void => {
    unsubscribeRecording?.();
    unsubscribeRecording = null;
    startedAt = null;
    wasRecording = false;
    stopTimer();
    snapshot = 0;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) start();

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
  };
}
