import { Directory, File as ExpoFile, Paths } from "expo-file-system";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Alert, AppState, Platform } from "react-native";
import { MAX_TRANSCRIPTION_ATTEMPTS, RECORDING_CHUNK_SECONDS, RECORDING_OPTIONS } from "./constants";
import { isExpoAudioAvailable, requestNotificationPermissionsAsync, requestRecordingPermissionsAsync, setAudioModeAsync, useSafeAudioRecorder, useSafeAudioRecorderState } from "./expo-audio-safe";
import { transcribeGroqChunk } from "./groq";
import { appendChunkToRecording, attachActiveSession, createRecordingSession, markSessionState, rehydrateInterruptedSession, requestSessionStop, selectRecording, updateChunkState } from "./recording-state";
import { createEmptyState, type HeadquartersState, type RecordingEntry } from "./models";
import { loadGroqApiKey, loadHeadquartersState, saveGroqApiKey, saveHeadquartersState } from "./store";

const recordingsDirectory = new Directory(Paths.document, "hasan-headquaters-recordings");

const ensureRecordingsDirectory = () => {
  recordingsDirectory.create({ idempotent: true, intermediates: true });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useDictationController() {
  const [state, setState] = useState<HeadquartersState>(() => createEmptyState());
  const [apiKey, setApiKey] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [isHydrating, setIsHydrating] = useState(true);
  const [isSavingApiKey, setIsSavingApiKey] = useState(false);
  const [isQueueRunning, setIsQueueRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef(state);
  const queueLoopActiveRef = useRef(false);
  const handledRecorderUrlsRef = useRef(new Set<string>());
  const isStoppingRef = useRef(false);

  const persistState = useEffectEvent(async (nextState: HeadquartersState) => {
    stateRef.current = nextState;
    setState(nextState);
    await saveHeadquartersState(nextState);
  });

  const updateState = useEffectEvent(async (updater: (currentState: HeadquartersState) => HeadquartersState) => {
    await persistState(updater(stateRef.current));
  });

  const finalizeChunk = useEffectEvent(async (status: any) => {
    const activeSession = stateRef.current.activeSession;
    const recordingId = activeSession?.recordingRef;
    const sourceUri = status.url;

    if (!activeSession || !recordingId || !sourceUri || handledRecorderUrlsRef.current.has(sourceUri)) {
      return;
    }

    handledRecorderUrlsRef.current.add(sourceUri);
    ensureRecordingsDirectory();

    const nextSequence = activeSession.chunkSequence;
    const destinationFile = new ExpoFile(recordingsDirectory, `${recordingId}-chunk-${String(nextSequence).padStart(4, "0")}.m4a`);
    const sourceFile = new ExpoFile(sourceUri);

    sourceFile.move(destinationFile);

    const fileInfo = destinationFile.info({ md5: false });
    const chunkEndedAt = new Date().toISOString();
    const chunkDurationMs = Math.max(1_000, new Date(chunkEndedAt).getTime() - new Date(activeSession.currentChunkStartedAt).getTime());
    const chunk = {
      id: `${recordingId}-chunk-${nextSequence}`,
      sequence: nextSequence,
      fileUri: destinationFile.uri,
      fileName: destinationFile.name,
      sizeBytes: fileInfo.size ?? 0,
      durationMs: chunkDurationMs,
      startedAt: activeSession.currentChunkStartedAt,
      endedAt: chunkEndedAt,
      status: "queued",
      attempts: 0,
      text: "",
      error: status.error ?? null,
      updatedAt: chunkEndedAt,
    };

    const shouldKeepRecording = !activeSession.stopRequested;

    await updateState((currentState) =>
      appendChunkToRecording(currentState, {
        recordingId,
        chunk,
        nextChunkSequence: nextSequence + 1,
        nextChunkStartedAt: shouldKeepRecording ? new Date().toISOString() : null,
        shouldKeepRecording,
      }),
    );

    if (shouldKeepRecording) {
      try {
        await recorder.prepareToRecordAsync(RECORDING_OPTIONS);
        recorder.record({ forDuration: RECORDING_CHUNK_SECONDS });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Unable to continue recording the next chunk.");
        await updateState((currentState) =>
          updateChunkState(currentState, {
            recordingId,
            chunkId: chunk.id,
            status: "failed",
            error: "The chunk was saved, but the next background chunk failed to start.",
          }),
        );
      }
    }
  });

  const recorder = useSafeAudioRecorder(RECORDING_OPTIONS, (status) => {
    if (status.hasError) {
      setError(status.error ?? "The recorder reported an unexpected error.");
    }

    if (status.isFinished && status.url) {
      void finalizeChunk(status);
    }
  });

  const recorderState = useSafeAudioRecorderState(recorder, 250);

  const processQueue = useEffectEvent(async () => {
    if (queueLoopActiveRef.current) {
      return;
    }

    if (!apiKey.trim()) {
      return;
    }

    queueLoopActiveRef.current = true;
    setIsQueueRunning(true);

    try {
      while (true) {
        const candidate = stateRef.current.recordings
          .flatMap((recording: RecordingEntry) =>
            recording.chunks.map((chunk) => ({
              recordingId: recording.id,
              chunk,
            })),
          )
          .find(({ chunk }) => chunk.status === "queued" || (chunk.status === "failed" && chunk.attempts < MAX_TRANSCRIPTION_ATTEMPTS));

        if (!candidate) {
          break;
        }

        await updateState((currentState) =>
          updateChunkState(currentState, {
            recordingId: candidate.recordingId,
            chunkId: candidate.chunk.id,
            status: "uploading",
            attempts: candidate.chunk.attempts + 1,
            error: null,
          }),
        );

        try {
          const text = await transcribeGroqChunk({
            apiKey: apiKey.trim(),
            fileName: candidate.chunk.fileName,
            fileUri: candidate.chunk.fileUri,
          });

          await updateState((currentState) =>
            updateChunkState(currentState, {
              recordingId: candidate.recordingId,
              chunkId: candidate.chunk.id,
              status: "done",
              text,
              error: null,
              attempts: candidate.chunk.attempts + 1,
            }),
          );
        } catch (nextError) {
          const message = nextError instanceof Error ? nextError.message : "Groq transcription failed.";

          await updateState((currentState) =>
            updateChunkState(currentState, {
              recordingId: candidate.recordingId,
              chunkId: candidate.chunk.id,
              status: "failed",
              error: message,
              attempts: candidate.chunk.attempts + 1,
            }),
          );

          await sleep(1_000);
        }
      }
    } finally {
      queueLoopActiveRef.current = false;
      setIsQueueRunning(false);
    }
  });

  useEffect(() => {
    let isMounted = true;

    void (async () => {
      ensureRecordingsDirectory();
      const [storedState, storedApiKey] = await Promise.all([loadHeadquartersState(), loadGroqApiKey()]);

      if (!isMounted) {
        return;
      }

      const nextState = rehydrateInterruptedSession(storedState);
      stateRef.current = nextState;
      setState(nextState);
      setApiKey(storedApiKey);
      setApiKeyDraft(storedApiKey);
      setIsHydrating(false);
      await saveHeadquartersState(nextState);
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (isHydrating) {
      return;
    }

    void processQueue();
  }, [apiKey, isHydrating, processQueue, state.recordings]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        return;
      }

      void processQueue();

      const currentStatus = recorder.getStatus();
      if (stateRef.current.activeSession && !currentStatus.isRecording && !currentStatus.url && !isStoppingRef.current) {
        void (async () => {
          try {
            await recorder.prepareToRecordAsync(RECORDING_OPTIONS);
            recorder.record({ forDuration: RECORDING_CHUNK_SECONDS });
          } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : "Unable to recover the recorder after the app resumed.");
          }
        })();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [processQueue, recorder]);

  const selectedRecording = useMemo(() => state.recordings.find((recording) => recording.id === state.selectedRecordingId) ?? state.recordings[0] ?? null, [state.recordings, state.selectedRecordingId]);

  const saveApiKey = async () => {
    setIsSavingApiKey(true);

    try {
      await saveGroqApiKey(apiKeyDraft);
      setApiKey(apiKeyDraft.trim());
      setNotice(apiKeyDraft.trim() ? "Groq API key saved on this device." : "Groq API key cleared. Recordings will queue until you add one again.");
    } finally {
      setIsSavingApiKey(false);
    }
  };

  const startRecording = async () => {
    try {
      setError(null);
      setNotice(null);

      if (!isExpoAudioAvailable()) {
        setError("Audio recording is unavailable in this iOS build right now.");
        return;
      }

      const recordingPermission = await requestRecordingPermissionsAsync();
      if (!recordingPermission.granted) {
        Alert.alert("Microphone needed", "Hasan Headquaters needs microphone access to start dictation.");
        return;
      }

      if (Platform.OS === "android") {
        await requestNotificationPermissionsAsync().catch(() => null);
      }

      await setAudioModeAsync({
        allowsRecording: true,
        allowsBackgroundRecording: true,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
      });

      const { recording, activeSession } = createRecordingSession();
      await updateState((currentState) => attachActiveSession(currentState, recording, activeSession));
      await updateState((currentState) => markSessionState(currentState, "armed"));
      await recorder.prepareToRecordAsync(RECORDING_OPTIONS);
      handledRecorderUrlsRef.current.clear();
      recorder.record({ forDuration: RECORDING_CHUNK_SECONDS });
      await updateState((currentState) => markSessionState(currentState, "recording"));
      setNotice("Recording started. The app will roll into small chunks so long dictation sessions stay safe.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to start recording.");
    }
  };

  const stopRecording = async () => {
    if (!stateRef.current.activeSession || isStoppingRef.current) {
      return;
    }

    try {
      isStoppingRef.current = true;
      await updateState((currentState) => requestSessionStop(currentState));
      await recorder.stop();
      setNotice("Recording stopped. Any queued chunks will keep transcribing in the background.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to stop recording cleanly.");
    } finally {
      isStoppingRef.current = false;
    }
  };

  return {
    apiKeyDraft,
    error,
    isHydrating,
    isQueueRunning,
    isRecording: Boolean(state.activeSession),
    isSavingApiKey,
    notice,
    recorderState,
    recordings: state.recordings,
    saveApiKey,
    selectedRecording,
    selectRecording: (recordingId: string | null) => {
      void updateState((currentState) => selectRecording(currentState, recordingId));
    },
    setApiKeyDraft,
    startRecording,
    stopRecording,
  };
}
