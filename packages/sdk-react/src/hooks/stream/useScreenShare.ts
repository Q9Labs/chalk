export function useScreenShare() {
  return { isSharing: false, isLocalSharing: false, videoTrack: null, audioTrack: null, start: async () => {}, stop: async () => {}, toggle: async () => {} };
}
