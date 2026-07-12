import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordingState } from "../internal/core";
import type { ExternalStateManager } from "./external-store";
import { createRecordingDurationStore } from "./recording-duration-store";

function createRecordingManager(): { manager: ExternalStateManager<RecordingState>; setState: (state: RecordingState) => void } {
  let state: RecordingState = {
    isRecording: false,
    isStarting: false,
    isStopping: false,
    recordingId: null,
    startedAt: null,
  };
  const listeners = new Set<(state: RecordingState) => void>();

  return {
    manager: {
      getState: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setState: (nextState) => {
      state = nextState;
      listeners.forEach((listener) => listener(state));
    },
  };
}

describe("createRecordingDurationStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks elapsed recording seconds and resets when recording stops", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const source = createRecordingManager();
    const store = createRecordingDurationStore(source.manager);
    const unsubscribe = store.subscribe(() => {});

    source.setState({ ...source.manager.getState(), isRecording: true, recordingId: "recording-1" });
    vi.advanceTimersByTime(2500);
    expect(store.getSnapshot()).toBe(2);

    source.setState({ ...source.manager.getState(), isRecording: false, recordingId: null });
    expect(store.getSnapshot()).toBe(0);

    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });
});
