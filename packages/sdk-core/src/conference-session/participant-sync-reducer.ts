import type { Participant } from "../types.ts";

export const applyVideoUpdatePatch = (existing: Participant, incoming: Participant): Participant => ({
  ...existing,
  videoEnabled: incoming.videoEnabled,
  videoTrack: incoming.videoTrack,
});

export const applyAudioUpdatePatch = (existing: Participant, incoming: Participant): Participant => ({
  ...existing,
  audioEnabled: incoming.audioEnabled,
  audioTrack: incoming.audioTrack,
});

export const applyScreenShareUpdatePatch = (existing: Participant, incoming: Participant): Participant => ({
  ...existing,
  isScreenSharing: incoming.isScreenSharing,
  screenShareTrack: incoming.screenShareTrack,
  screenShareAudioTrack: incoming.screenShareAudioTrack,
});

export const mergeParticipantMediaState = (existing: Participant, incoming: Participant): Participant => ({
  ...existing,
  userId: incoming.userId ?? existing.userId,
  displayName: incoming.displayName || existing.displayName,
  videoEnabled: incoming.videoEnabled,
  audioEnabled: incoming.audioEnabled,
  videoTrack: incoming.videoTrack,
  audioTrack: incoming.audioTrack,
  isScreenSharing: incoming.isScreenSharing,
  screenShareTrack: incoming.screenShareTrack,
  screenShareAudioTrack: incoming.screenShareAudioTrack,
  isLocal: false,
});

export const hasMediaStateChanged = (before: Participant, after: Participant): boolean =>
  before.displayName !== after.displayName ||
  before.videoEnabled !== after.videoEnabled ||
  before.audioEnabled !== after.audioEnabled ||
  before.isScreenSharing !== after.isScreenSharing ||
  before.videoTrack?.id !== after.videoTrack?.id ||
  before.audioTrack?.id !== after.audioTrack?.id ||
  before.screenShareTrack?.id !== after.screenShareTrack?.id ||
  before.screenShareAudioTrack?.id !== after.screenShareAudioTrack?.id;
