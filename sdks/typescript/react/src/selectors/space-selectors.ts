import { deviceHint } from "./device-hint";
import type { LocalMedia, MediaSource, Participant as SpaceParticipant, RemoteMedia } from "@q9labsai/chalk-client";

import type { AudioParticipant } from "../components/audio-output/AudioOutput";
import type { Participant } from "../components/participant-grid/ParticipantGrid";

export function toVideoParticipants(participants: readonly SpaceParticipant[], remoteMedia: readonly RemoteMedia[], localId: string, displayName: string, localMedia: Readonly<Record<MediaSource, LocalMedia>>): Participant[] {
  const remoteByParticipant = new Map<string, Partial<Record<"camera" | "screen", MediaStreamTrack>> & { cameraPausedForNetwork?: true }>();
  const stateByParticipant = new Map(participants.map((participant) => [participant.participantId, participant.media]));
  for (const publication of remoteMedia) {
    if (publication.source === "microphone" || publication.source === "screen_audio") continue;
    const state = stateByParticipant.get(publication.participantId);
    if (!state || (publication.source === "camera" ? state.camera : state.screenShare) !== "active") continue;
    const media = remoteByParticipant.get(publication.participantId) ?? {};
    media[publication.source] = publication.track;
    if (publication.source === "camera" && publication.pausedForNetwork) media.cameraPausedForNetwork = true;
    remoteByParticipant.set(publication.participantId, media);
  }
  const localFromSync = participants.find((participant) => participant.participantId === localId);
  const result: Participant[] = [
    {
      id: localId,
      displayName: localFromSync?.displayName || displayName,
      deviceHint: deviceHint(localFromSync, participants),
      isLocal: true,
      isMuted: localMedia.microphone.state !== "enabled",
      isSpeaking: localFromSync?.presence.speaking ?? false,
      isActiveSpeaker: localFromSync?.presence.activeSpeaker ?? false,
      isVideoEnabled: localMedia.camera.state === "enabled",
      isScreenSharing: localMedia.screen.state === "enabled" || localMedia.screen.state === "requesting",
      isHandRaised: localFromSync?.handRaised,
      videoTrack: localMedia.camera.track,
      screenShareTrack: localMedia.screen.track,
    },
  ];
  for (const participant of participants) {
    if (participant.participantId === localId) continue;
    const media = remoteByParticipant.get(participant.participantId);
    result.push({
      id: participant.participantId,
      displayName: participant.displayName,
      deviceHint: deviceHint(participant, participants),
      isOwnDevice: Boolean(localFromSync?.identityId && participant.identityId === localFromSync.identityId),
      isMuted: participant.media.microphone !== "active",
      isSpeaking: participant.presence.speaking,
      isActiveSpeaker: participant.presence.activeSpeaker,
      isVideoEnabled: participant.media.camera === "active" && Boolean(media?.camera),
      isScreenSharing: participant.media.screenShare === "active" && Boolean(media?.screen),
      isHandRaised: participant.handRaised,
      ...tileSignal(participant),
      ...(media?.cameraPausedForNetwork ? { isVideoPausedForNetwork: true } : {}),
      videoTrack: media?.camera,
      screenShareTrack: media?.screen,
      videoPublicationId: participant.media.cameraPublicationId,
      screenSharePublicationId: participant.media.screenSharePublicationId,
    });
  }
  return result;
}

/** What a guest's own rating and presence say about their tile. Unknown shows no signal at all. */
const TILE_BARS = { good: 4, weak: 2, poor: 1 } as const;

function tileSignal(participant: SpaceParticipant): Pick<Participant, "connectionQuality" | "isReconnecting"> {
  const { connectionQuality, state } = participant.presence;
  const quality = connectionQuality === undefined ? undefined : TILE_BARS[connectionQuality];
  return { ...(quality === undefined ? {} : { connectionQuality: quality }), ...(state === "disconnected" ? { isReconnecting: true } : {}) };
}

export function toAudioParticipants(remoteMedia: readonly RemoteMedia[]): AudioParticipant[] {
  const byParticipant = new Map<string, AudioParticipant>();
  for (const publication of remoteMedia) {
    if (publication.track.kind !== "audio") continue;
    const participant = byParticipant.get(publication.participantId) ?? { id: publication.participantId };
    if (publication.source === "microphone") participant.audioTrack = publication.track;
    if (publication.source === "screen_audio") participant.screenShareAudioTrack = publication.track;
    byParticipant.set(publication.participantId, participant);
  }
  return [...byParticipant.values()];
}
