export type MeetingRoomSettings = any;
const profileGradient = { id: "chalk-neutral", label: "Neutral", from: "#64748b", to: "#94a3b8" };
export const DEFAULT_MEETING_ROOM_SETTINGS: any = {
  identity: { displayName: "" },
  join: { videoEnabled: false, audioEnabled: false },
  audio: { selectedInput: undefined, selectedOutput: undefined, outputVolume: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
  video: { selectedInput: undefined, quality: "auto" },
  appearance: { layout: "grid", theme: "system", showFilmstrip: true, reducedMotion: false, generatedAvatars: true, gradient: "default", profileGradient, ambientBackground: true },
  experience: { captions: false, compactMode: false, showInviteToast: true, defaultOpenChat: false, defaultOpenParticipants: false, defaultOpenTranscription: false, autoOpenPictureInPicture: false },
};
export function getStoredMeetingRoomSettings(): any {
  return DEFAULT_MEETING_ROOM_SETTINGS;
}
export function useMeetingRoomSettings(_options: any = {}): any {
  return {
    settings: DEFAULT_MEETING_ROOM_SETTINGS,
    updateSettings: (_next: any) => {},
    resetSettings: () => {},
    updateIdentitySettings: (_next: any) => {},
    updateJoinSettings: (_next: any) => {},
    updateAudioSettings: (_next: any) => {},
    updateVideoSettings: (_next: any) => {},
    updateAppearanceSettings: (_next: any) => {},
    updateExperienceSettings: (_next: any) => {},
  };
}
