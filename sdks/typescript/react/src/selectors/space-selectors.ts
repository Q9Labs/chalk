import type { LocalMedia, MediaSource, Participant as SpaceParticipant, RemoteMedia } from "@q9labsai/chalk-client";

import type { AudioParticipant } from "../components/audio-output/AudioOutput";
import type { Participant } from "../components/participant-grid/ParticipantGrid";
import type { ParticipantListParticipant } from "../components/participants-panel/ParticipantsPanel";

/** Returns the first participant with a live screen-share track for presentation mode. */
export function toActiveScreenShare(participants: readonly Participant[]): Participant | undefined {
  return participants.find((participant) => participant.isScreenSharing && participant.screenShareTrack != null);
}

export function toVideoParticipants(participants: readonly SpaceParticipant[], remoteMedia: readonly RemoteMedia[], localId: string, displayName: string, localMedia: Readonly<Record<MediaSource, LocalMedia>>): Participant[] {
  const remoteByParticipant = new Map<string, Partial<Record<"camera" | "screen", MediaStreamTrack>>>();
  for (const publication of remoteMedia) {
    if (publication.source === "microphone") continue;
    const media = remoteByParticipant.get(publication.participantId) ?? {};
    media[publication.source] = publication.track;
    remoteByParticipant.set(publication.participantId, media);
  }
  const localFromSync = participants.find((participant) => participant.participantId === localId);
  const result: Participant[] = [
    {
      id: localId,
      displayName: localFromSync?.displayName || displayName,
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
      isMuted: !remoteMedia.some((publication) => publication.participantId === participant.participantId && publication.source === "microphone"),
      isSpeaking: participant.presence.speaking,
      isActiveSpeaker: participant.presence.activeSpeaker,
      isVideoEnabled: Boolean(media?.camera),
      isScreenSharing: Boolean(media?.screen),
      isHandRaised: participant.handRaised,
      videoTrack: media?.camera,
      screenShareTrack: media?.screen,
    });
  }
  return result;
}

export function toAudioParticipants(remoteMedia: readonly RemoteMedia[]): AudioParticipant[] {
  const byParticipant = new Map<string, AudioParticipant>();
  for (const publication of remoteMedia) {
    if (publication.track.kind !== "audio") continue;
    const participant = byParticipant.get(publication.participantId) ?? { id: publication.participantId };
    if (publication.source === "microphone") participant.audioTrack = publication.track;
    if (publication.source === "screen") participant.screenShareAudioTrack = publication.track;
    byParticipant.set(publication.participantId, participant);
  }
  return [...byParticipant.values()];
}

export function toParticipantNames(participants: readonly SpaceParticipant[], localId: string, displayName: string): Readonly<Record<string, string>> {
  return Object.fromEntries([...participants.map((participant) => [participant.participantId, participant.displayName] as const), [localId, participants.find((participant) => participant.participantId === localId)?.displayName ?? displayName]]);
}

export function toListParticipants(tiles: readonly Participant[], participantMedia: Readonly<Record<string, SpaceParticipant["media"]>>): ParticipantListParticipant[] {
  return tiles.map((participant) => {
    const media = participantMedia[participant.id];
    return {
      id: participant.id,
      displayName: participant.displayName,
      isLocal: participant.isLocal,
      isMuted: media?.microphone === "active" ? false : media?.microphone === "inactive" ? true : participant.isMuted,
      isVideoEnabled: media?.camera === "active" ? true : media?.camera === "inactive" ? false : participant.isVideoEnabled,
      isHandRaised: participant.isHandRaised,
    };
  });
}
