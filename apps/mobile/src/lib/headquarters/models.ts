export const createEmptyChunk = () => ({
  id: "",
  sequence: 0,
  fileUri: "",
  fileName: "",
  sizeBytes: 0,
  durationMs: 0,
  startedAt: "",
  endedAt: "",
  status: "queued",
  attempts: 0,
  text: "",
  error: null as string | null,
  updatedAt: "",
});

export const createEmptyRecording = () => ({
  id: "",
  title: "",
  createdAt: "",
  updatedAt: "",
  startedAt: "",
  endedAt: null as string | null,
  status: "draft",
  transcript: "",
  error: null as string | null,
  totalDurationMs: 0,
  totalBytes: 0,
  chunks: [] as Array<ReturnType<typeof createEmptyChunk>>,
});

export const createEmptyActiveSession = () => ({
  recordingId: "",
  recordingRef: null as string | null,
  chunkSequence: 0,
  currentChunkStartedAt: "",
  stopRequested: false,
  status: "idle",
});

export const createEmptyState = () => ({
  recordings: [] as Array<ReturnType<typeof createEmptyRecording>>,
  activeSession: null as ReturnType<typeof createEmptyActiveSession> | null,
  selectedRecordingId: null as string | null,
  updatedAt: new Date().toISOString(),
});

export type HeadquartersState = ReturnType<typeof createEmptyState>;
export type RecordingEntry = ReturnType<typeof createEmptyRecording>;
export type RecordingChunk = ReturnType<typeof createEmptyChunk>;
