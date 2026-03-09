import type { Participant as MeetingParticipant } from "../meeting-room/types";

import type { PictureInPictureSource } from "./types";

function hasLiveTrack(track: MediaStreamTrack | null | undefined) {
  return Boolean(track && track.readyState !== "ended");
}

export function buildPreJoinPictureInPictureSource({ displayName, videoTrack, isAudioEnabled, isVideoEnabled }: { displayName: string; videoTrack?: MediaStreamTrack | null; isAudioEnabled: boolean; isVideoEnabled: boolean }): PictureInPictureSource {
  return {
    id: "prejoin-local",
    kind: "participant",
    title: displayName,
    subtitle: "Ready to join",
    videoTrack: isVideoEnabled && hasLiveTrack(videoTrack) ? videoTrack : null,
    isMuted: !isAudioEnabled,
    isLocal: true,
  };
}

export function buildMeetingPictureInPictureSource({ participants, localParticipant }: { participants: MeetingParticipant[]; localParticipant: MeetingParticipant }) {
  const screenSharer = participants.find((participant) => participant.isScreenSharing && hasLiveTrack(participant.screenShareTrack));

  if (screenSharer) {
    return {
      source: {
        id: `screen-share:${screenSharer.id}`,
        kind: "screen-share",
        title: screenSharer.displayName,
        subtitle: "Screen sharing",
        videoTrack: screenSharer.screenShareTrack,
        isMuted: screenSharer.isMuted,
        isLocal: screenSharer.isLocal,
      } satisfies PictureInPictureSource,
      previewSource: localParticipant.id !== screenSharer.id ? buildParticipantSource(localParticipant) : null,
    };
  }

  const activeSpeaker = participants.find((participant) => participant.isSpeaking && participant.isVideoEnabled && hasLiveTrack(participant.videoTrack));
  const firstRemoteVideo = participants.find((participant) => !participant.isLocal && participant.isVideoEnabled && hasLiveTrack(participant.videoTrack));
  const localVideo = localParticipant.isVideoEnabled && hasLiveTrack(localParticipant.videoTrack) ? localParticipant : null;
  const fallbackParticipant = activeSpeaker ?? firstRemoteVideo ?? localVideo ?? participants[0] ?? localParticipant;

  const source = buildParticipantSource(fallbackParticipant);
  const previewSource = localVideo && source?.id !== localParticipant.id ? buildParticipantSource(localParticipant) : null;

  return {
    source,
    previewSource,
  };
}

function buildParticipantSource(participant: MeetingParticipant | null | undefined): PictureInPictureSource | null {
  if (!participant) {
    return null;
  }

  return {
    id: participant.id,
    kind: "participant",
    title: participant.displayName,
    subtitle: participant.isLocal ? "You" : "Live",
    videoTrack: participant.isVideoEnabled && hasLiveTrack(participant.videoTrack) ? participant.videoTrack : null,
    avatarUrl: participant.avatarUrl,
    isMuted: participant.isMuted,
    isLocal: participant.isLocal,
  };
}
