import type { Participant } from "../types.ts";

export interface RtkResolvedIds {
  stableId: string;
  peerId: string;
  userId?: string;
}

export const getRtkIds = (
  peerIdMap: Map<string, string>,
  rtkParticipant: unknown,
): RtkResolvedIds => {
  const participant = rtkParticipant as Record<string, unknown>;

  const peerId =
    typeof participant.id === "string" && participant.id.length > 0
      ? participant.id
      : crypto.randomUUID();

  const directUserId =
    (typeof participant.userId === "string" && participant.userId.length > 0
      ? participant.userId
      : undefined) ??
    (typeof participant.clientSpecificId === "string" &&
    participant.clientSpecificId.length > 0
      ? participant.clientSpecificId
      : undefined) ??
    (typeof participant.client_specific_id === "string" &&
    participant.client_specific_id.length > 0
      ? participant.client_specific_id
      : undefined) ??
    (typeof participant.customParticipantId === "string" &&
    participant.customParticipantId.length > 0
      ? participant.customParticipantId
      : undefined) ??
    (typeof participant.custom_participant_id === "string" &&
    participant.custom_participant_id.length > 0
      ? participant.custom_participant_id
      : undefined);

  const mapped = peerIdMap.get(peerId);
  const userId = directUserId ?? mapped;
  const stableId = userId ?? peerId;

  if (directUserId) {
    peerIdMap.set(peerId, directUserId);
  }

  return { stableId, peerId, userId };
};

export const mapRtkParticipant = (
  peerIdMap: Map<string, string>,
  rtkParticipant: unknown,
): Participant => {
  const participant = rtkParticipant as Record<string, unknown>;
  const { stableId, userId } = getRtkIds(peerIdMap, rtkParticipant);
  const screenShareVideoTrack =
    (participant.screenShareTracks as { video?: MediaStreamTrack } | undefined)
      ?.video ??
    (participant.screenShareVideoTrack as MediaStreamTrack | undefined) ??
    undefined;
  const screenShareAudioTrack =
    (participant.screenShareTracks as { audio?: MediaStreamTrack } | undefined)
      ?.audio ??
    (participant.screenShareAudioTrack as MediaStreamTrack | undefined) ??
    undefined;

  return {
    id: stableId,
    userId,
    displayName: (participant.name as string) ?? "Unknown",
    role: "participant",
    isLocal: false,
    videoEnabled: (participant.videoEnabled as boolean) ?? false,
    audioEnabled: (participant.audioEnabled as boolean) ?? false,
    videoTrack: participant.videoTrack as MediaStreamTrack | undefined,
    audioTrack: participant.audioTrack as MediaStreamTrack | undefined,
    screenShareTrack: screenShareVideoTrack,
    screenShareAudioTrack,
    isSpeaking: false,
    isScreenSharing: (participant.screenShareEnabled as boolean) ?? false,
    handRaised: false,
    connectionQuality: 100,
  };
};
