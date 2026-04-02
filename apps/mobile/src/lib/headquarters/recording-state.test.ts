import { describe, expect, it } from "vitest";
import { appendChunkToRecording, attachActiveSession, createRecordingSession, rehydrateInterruptedSession, updateChunkState } from "./recording-state";

describe("recording-state", () => {
  it("assembles transcript text from completed chunks in sequence order", () => {
    const baseState = {
      recordings: [],
      activeSession: null,
      selectedRecordingId: null,
      updatedAt: "2026-04-02T00:00:00.000Z",
    };
    const { recording, activeSession } = createRecordingSession(new Date("2026-04-02T10:00:00.000Z"));
    const withSession = attachActiveSession(baseState, recording, activeSession);
    const afterChunk = appendChunkToRecording(withSession, {
      recordingId: recording.id,
      chunk: {
        id: "chunk-1",
        sequence: 1,
        fileUri: "file:///chunk-1.m4a",
        fileName: "chunk-1.m4a",
        sizeBytes: 10,
        durationMs: 1000,
        startedAt: "2026-04-02T10:00:00.000Z",
        endedAt: "2026-04-02T10:01:00.000Z",
        status: "queued",
        attempts: 0,
        text: "",
        error: null,
        updatedAt: "2026-04-02T10:01:00.000Z",
      },
      nextChunkSequence: 2,
      nextChunkStartedAt: null,
      shouldKeepRecording: false,
    });
    const withText = updateChunkState(afterChunk, {
      recordingId: recording.id,
      chunkId: "chunk-1",
      status: "done",
      text: "first block",
      error: null,
      attempts: 1,
    });

    expect(withText.recordings[0]?.transcript).toBe("first block");
    expect(withText.recordings[0]?.status).toBe("ready");
  });

  it("marks a previously active session as interrupted on hydrate", () => {
    const { recording, activeSession } = createRecordingSession(new Date("2026-04-02T10:00:00.000Z"));
    const nextState = rehydrateInterruptedSession({
      recordings: [recording],
      activeSession: {
        ...activeSession,
        recordingRef: recording.id,
      },
      selectedRecordingId: recording.id,
      updatedAt: "2026-04-02T10:00:00.000Z",
    });

    expect(nextState.activeSession).toBeNull();
    expect(nextState.recordings[0]?.status).toBe("attention");
    expect(nextState.recordings[0]?.error).toContain("interrupted");
  });
});
