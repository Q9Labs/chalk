export function useMedia() {
  return { isAudioEnabled: false, isVideoEnabled: false, audioTrack: null, videoTrack: null, toggleAudio: () => {}, toggleVideo: () => {}, enableAudio: async () => {}, disableAudio: async () => {}, enableVideo: async () => {}, disableVideo: async () => {} };
}
