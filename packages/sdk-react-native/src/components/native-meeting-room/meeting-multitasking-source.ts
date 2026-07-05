import type { ParticipantState } from "../../internal/core";
import type { ResolvedNativeMeetingLayout } from "../../utils/native-meeting-layout";

type RoomParticipant = ParticipantState["participants"][number];

export interface NativeMeetingMultitaskingSource {
  participantName: string;
  track: MediaStreamTrack | null;
}

function pickParticipantVideoTrack(participant: RoomParticipant | null | undefined): MediaStreamTrack | null {
  return participant?.videoTrack ?? null;
}

export function resolveNativeMeetingMultitaskingSource({
  activeSpeaker,
  allParticipants,
  derived,
  localParticipant,
  selfName,
}: {
  activeSpeaker: RoomParticipant | null;
  allParticipants: readonly RoomParticipant[];
  derived: ResolvedNativeMeetingLayout;
  localParticipant: RoomParticipant | null;
  selfName: string;
}): NativeMeetingMultitaskingSource {
  if (derived.showScreenShare) {
    return {
      participantName: derived.screenSharer?.displayName || selfName,
      track: derived.screenShareTrack,
    };
  }

  const activeSpeakerTrack = pickParticipantVideoTrack(activeSpeaker);
  if (activeSpeakerTrack) {
    return {
      participantName: activeSpeaker?.displayName || selfName,
      track: activeSpeakerTrack,
    };
  }

  const localTrack = pickParticipantVideoTrack(localParticipant);
  if (localTrack) {
    return {
      participantName: localParticipant?.displayName || selfName,
      track: localTrack,
    };
  }

  for (const participant of allParticipants) {
    const participantTrack = pickParticipantVideoTrack(participant);
    if (participantTrack) {
      return {
        participantName: participant.displayName || selfName,
        track: participantTrack,
      };
    }
  }

  return {
    participantName: selfName,
    track: null,
  };
}
