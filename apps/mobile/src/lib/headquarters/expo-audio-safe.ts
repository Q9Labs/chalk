import { useMemo } from "react";
import type { RecordingOptions } from "expo-audio";

const expoAudio = (() => {
  try {
    return require("expo-audio") as typeof import("expo-audio");
  } catch {
    return null;
  }
})();

const createUnavailablePermissions = async () => ({
  canAskAgain: false,
  expires: "never" as const,
  granted: false,
  status: "undetermined" as const,
});

const createUnavailableRecorder = () => ({
  getStatus: () => ({
    hasError: false,
    isFinished: false,
    isRecording: false,
    url: null as string | null,
  }),
  prepareToRecordAsync: async (_options: unknown) => {
    throw new Error("Audio recording is unavailable in this build.");
  },
  record: (_options: { forDuration: number }) => {},
  stop: async () => {},
});

export const ExpoAudioQuality = expoAudio?.AudioQuality ?? {
  LOW: "low",
};

export const ExpoIOSOutputFormat = expoAudio?.IOSOutputFormat ?? {
  MPEG4AAC: "aac",
};

export const requestNotificationPermissionsAsync = expoAudio?.requestNotificationPermissionsAsync ?? createUnavailablePermissions;
export const requestRecordingPermissionsAsync = expoAudio?.requestRecordingPermissionsAsync ?? createUnavailablePermissions;
export const setAudioModeAsync = expoAudio?.setAudioModeAsync ?? (async (_mode: unknown) => {});

export function useSafeAudioRecorder(options: RecordingOptions, onStatus: (status: any) => void) {
  return expoAudio?.useAudioRecorder ? expoAudio.useAudioRecorder(options, onStatus) : useMemo(() => createUnavailableRecorder(), []);
}

export function useSafeAudioRecorderState(recorder: any, interval: number) {
  return expoAudio?.useAudioRecorderState
    ? expoAudio.useAudioRecorderState(recorder, interval)
    : useMemo(
        () => ({
          canRecord: false,
          durationMillis: 0,
          isRecording: false,
          isRecordingInterrupted: false,
          mediaServicesDidReset: false,
        }),
        [],
      );
}

export function isExpoAudioAvailable() {
  return expoAudio != null;
}
