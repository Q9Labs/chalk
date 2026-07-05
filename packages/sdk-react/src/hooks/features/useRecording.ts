export function useRecording() {
  return { isRecording: false, isStarting: false, isStopping: false, recordingId: null, durationSeconds: 0, start: async () => "", stop: async () => {}, toggle: async () => {} };
}
