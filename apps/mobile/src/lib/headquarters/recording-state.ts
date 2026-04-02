const createId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const buildTitle = (isoTimestamp: string) => {
  const date = new Date(isoTimestamp);
  const dateLabel = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const timeLabel = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${dateLabel} ${timeLabel}`;
};

const mergeChunkTranscript = (chunks: Array<{ text: string; sequence: number }>) =>
  chunks
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map((chunk) => chunk.text.trim())
    .filter(Boolean)
    .join("\n\n");

const deriveRecordingStatus = ({ chunkStatuses, endedAt, isActive }: { chunkStatuses: string[]; endedAt: string | null; isActive: boolean }) => {
  if (isActive) {
    return "recording";
  }

  if (chunkStatuses.some((status) => status === "failed")) {
    return "attention";
  }

  if (chunkStatuses.some((status) => status === "queued" || status === "uploading")) {
    return "transcribing";
  }

  return endedAt ? "ready" : "draft";
};

export function createRecordingSession(now = new Date()) {
  const startedAt = now.toISOString();

  return {
    recording: {
      id: createId("recording"),
      title: buildTitle(startedAt),
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
      endedAt: null,
      status: "recording",
      transcript: "",
      error: null,
      totalDurationMs: 0,
      totalBytes: 0,
      chunks: [],
    },
    activeSession: {
      recordingId: createId("active"),
      recordingRef: null,
      chunkSequence: 0,
      currentChunkStartedAt: startedAt,
      stopRequested: false,
      status: "starting",
    },
  };
}

export function attachActiveSession(state: HeadquartersState, recording: RecordingEntry, activeSession: NonNullable<HeadquartersState["activeSession"]>) {
  const nextRecording = { ...recording };
  const nextSession = { ...activeSession, recordingRef: nextRecording.id };

  return {
    ...state,
    recordings: [nextRecording, ...state.recordings.filter((item) => item.id !== nextRecording.id)],
    activeSession: nextSession,
    selectedRecordingId: nextRecording.id,
    updatedAt: new Date().toISOString(),
  };
}

export function markSessionState(state: HeadquartersState, nextStatus: string) {
  if (!state.activeSession) {
    return state;
  }

  return {
    ...state,
    activeSession: {
      ...state.activeSession,
      status: nextStatus,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function requestSessionStop(state: HeadquartersState) {
  if (!state.activeSession) {
    return state;
  }

  return {
    ...state,
    activeSession: {
      ...state.activeSession,
      stopRequested: true,
      status: "stopping",
    },
    updatedAt: new Date().toISOString(),
  };
}

export function appendChunkToRecording(
  state: HeadquartersState,
  input: {
    recordingId: string;
    chunk: RecordingChunk;
    nextChunkSequence: number;
    nextChunkStartedAt: string | null;
    shouldKeepRecording: boolean;
  },
) {
  const nextRecordings = state.recordings.map((recording: RecordingEntry) => {
    if (recording.id !== input.recordingId) {
      return recording;
    }

    const nextChunks = [...recording.chunks, input.chunk];
    const nextEndedAt = input.shouldKeepRecording ? null : input.chunk.endedAt;
    const status = deriveRecordingStatus({
      chunkStatuses: nextChunks.map((chunk: RecordingChunk) => chunk.status),
      endedAt: nextEndedAt,
      isActive: input.shouldKeepRecording,
    });

    return {
      ...recording,
      updatedAt: input.chunk.endedAt,
      endedAt: nextEndedAt,
      status,
      error: input.chunk.error ?? null,
      totalDurationMs: recording.totalDurationMs + input.chunk.durationMs,
      totalBytes: recording.totalBytes + input.chunk.sizeBytes,
      chunks: nextChunks,
      transcript: mergeChunkTranscript(nextChunks),
    };
  });

  return {
    ...state,
    recordings: nextRecordings,
    activeSession:
      input.shouldKeepRecording && state.activeSession && input.nextChunkStartedAt
        ? {
            recordingId: state.activeSession.recordingId,
            recordingRef: state.activeSession.recordingRef,
            chunkSequence: input.nextChunkSequence,
            currentChunkStartedAt: input.nextChunkStartedAt,
            stopRequested: false,
            status: "recording",
          }
        : null,
    updatedAt: input.chunk.endedAt,
  };
}

export function updateChunkState(
  state: HeadquartersState,
  input: {
    recordingId: string;
    chunkId: string;
    status: string;
    text?: string;
    error?: string | null;
    attempts?: number;
  },
) {
  const now = new Date().toISOString();
  const nextRecordings = state.recordings.map((recording: RecordingEntry) => {
    if (recording.id !== input.recordingId) {
      return recording;
    }

    const nextChunks = recording.chunks.map((chunk: RecordingChunk) =>
      chunk.id === input.chunkId
        ? {
            ...chunk,
            status: input.status,
            text: input.text ?? chunk.text,
            error: input.error ?? chunk.error,
            attempts: input.attempts ?? chunk.attempts,
            updatedAt: now,
          }
        : chunk,
    );

    return {
      ...recording,
      updatedAt: now,
      status: deriveRecordingStatus({
        chunkStatuses: nextChunks.map((chunk: RecordingChunk) => chunk.status),
        endedAt: recording.endedAt,
        isActive: state.activeSession?.recordingRef === recording.id,
      }),
      error: input.status === "failed" ? (input.error ?? recording.error) : null,
      chunks: nextChunks,
      transcript: mergeChunkTranscript(nextChunks),
    };
  });

  return {
    ...state,
    recordings: nextRecordings,
    updatedAt: now,
  };
}

export function rehydrateInterruptedSession(state: HeadquartersState) {
  const recordingRef = state.activeSession?.recordingRef;

  if (!recordingRef) {
    return state;
  }

  const now = new Date().toISOString();
  const nextRecordings = state.recordings.map((recording: RecordingEntry) => {
    if (recording.id !== recordingRef) {
      return recording;
    }

    return {
      ...recording,
      updatedAt: now,
      endedAt: recording.endedAt ?? now,
      status: "attention",
      error: "Recording was interrupted before the app could close the active chunk cleanly.",
    };
  });

  return {
    ...state,
    recordings: nextRecordings,
    activeSession: null,
    updatedAt: now,
  };
}

export function selectRecording(state: HeadquartersState, recordingId: string | null) {
  return {
    ...state,
    selectedRecordingId: recordingId,
    updatedAt: new Date().toISOString(),
  };
}
import type { HeadquartersState, RecordingChunk, RecordingEntry } from "./models";
