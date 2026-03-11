import type { Participant as MeetingParticipant } from "../meeting-room/types";

import type { PictureInPictureMeetingLayout, PictureInPictureSource } from "./types";

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
    isSpeaking: false,
  };
}

export function buildMeetingPictureInPictureSource({
  participants,
  localParticipant,
  isWhiteboardOpen = false,
  whiteboardSnapshot,
}: {
  participants: MeetingParticipant[];
  localParticipant: MeetingParticipant;
  isWhiteboardOpen?: boolean;
  whiteboardSnapshot?: PictureInPictureSource["whiteboardSnapshot"] | null;
}) {
  const screenSharer = participants.find((participant) => participant.isScreenSharing && hasLiveTrack(participant.screenShareTrack));
  const rankedParticipants = rankMeetingParticipants(participants, localParticipant);

  if (isWhiteboardOpen && whiteboardSnapshot) {
    const participantSources = rankedParticipants
      .slice(0, 2)
      .map(buildParticipantSource)
      .filter((participant): participant is PictureInPictureSource => Boolean(participant));

    return {
      source: {
        id: "whiteboard",
        kind: "whiteboard",
        title: "Whiteboard",
        subtitle: "Live",
        whiteboardSnapshot,
      } satisfies PictureInPictureSource,
      previewSource: participantSources[0] ?? null,
      participantSources,
      meetingLayout: "screen-share" as const,
    };
  }

  if (screenSharer) {
    const participantSources = rankedParticipants
      .filter((participant) => participant.id !== screenSharer.id)
      .slice(0, 2)
      .map(buildParticipantSource)
      .filter((participant): participant is PictureInPictureSource => Boolean(participant));

    return {
      source: {
        id: `screen-share:${screenSharer.id}`,
        kind: "screen-share",
        title: screenSharer.displayName,
        subtitle: "Screen sharing",
        videoTrack: screenSharer.screenShareTrack,
        isMuted: screenSharer.isMuted,
        isLocal: screenSharer.isLocal,
        isSpeaking: screenSharer.isSpeaking,
        isHandRaised: screenSharer.isHandRaised,
        avatarUrl: screenSharer.avatarUrl,
      } satisfies PictureInPictureSource,
      previewSource: participantSources[0] ?? null,
      participantSources,
      meetingLayout: "screen-share" as const,
    };
  }

  const allSources = rankedParticipants.map(buildParticipantSource).filter((participant): participant is PictureInPictureSource => Boolean(participant));
  const participantSources = buildMeetingParticipantSources(allSources);
  const source = participantSources.find((participant) => participant.kind !== "placeholder") ?? participantSources[0] ?? buildParticipantSource(localParticipant);

  return {
    source,
    previewSource: null,
    participantSources,
    meetingLayout: determineMeetingLayout(participantSources),
  };
}

function rankMeetingParticipants(participants: MeetingParticipant[], localParticipant: MeetingParticipant) {
  const uniqueParticipants = new Map<string, { participant: MeetingParticipant; index: number }>();

  participants.forEach((participant, index) => {
    if (!uniqueParticipants.has(participant.id)) {
      uniqueParticipants.set(participant.id, { participant, index });
    }
  });

  if (!uniqueParticipants.has(localParticipant.id)) {
    uniqueParticipants.set(localParticipant.id, { participant: localParticipant, index: uniqueParticipants.size });
  }

  return Array.from(uniqueParticipants.values())
    .sort((left, right) => {
      const scoreDelta = getParticipantPriority(right.participant) - getParticipantPriority(left.participant);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return left.index - right.index;
    })
    .map(({ participant }) => participant);
}

function getParticipantPriority(participant: MeetingParticipant) {
  let score = 0;

  if (participant.isSpeaking) {
    score += 100;
  }

  if (!participant.isLocal) {
    score += 45;
  }

  if (participant.role === "host") {
    score += 25;
  } else if (participant.role === "co-host") {
    score += 20;
  }

  if (participant.isHandRaised) {
    score += 15;
  }

  if (participant.isVideoEnabled && hasLiveTrack(participant.videoTrack)) {
    score += 10;
  }

  if (!participant.isLocal && !participant.isVideoEnabled) {
    score += 5;
  }

  return score;
}

function buildMeetingParticipantSources(sources: PictureInPictureSource[]) {
  if (sources.length <= 4) {
    return sources;
  }

  return [
    ...sources.slice(0, 3),
    {
      id: `overflow:${sources.length - 3}`,
      kind: "placeholder",
      title: `+${sources.length - 3}`,
      subtitle: "more",
    } satisfies PictureInPictureSource,
  ];
}

function determineMeetingLayout(participantSources: PictureInPictureSource[]): PictureInPictureMeetingLayout {
  if (participantSources.length <= 1) {
    return "single";
  }

  if (participantSources.length === 2) {
    return "split";
  }

  return "grid";
}

function buildParticipantSource(participant: MeetingParticipant | null | undefined): PictureInPictureSource | null {
  if (!participant) {
    return null;
  }

  return {
    id: participant.id,
    kind: "participant",
    title: participant.displayName,
    subtitle: undefined,
    videoTrack: participant.isVideoEnabled && hasLiveTrack(participant.videoTrack) ? participant.videoTrack : null,
    avatarUrl: participant.avatarUrl,
    isMuted: participant.isMuted,
    isLocal: participant.isLocal,
    isSpeaking: participant.isSpeaking,
    isHandRaised: participant.isHandRaised,
  };
}
