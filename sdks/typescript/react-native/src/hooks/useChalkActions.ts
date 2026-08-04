import type { ChalkSessionActions } from "../client-compat";
import { useMemo } from "react";

import { useChalkSession } from "../context/chalk-provider";

export function useChalkActions(): ChalkSessionActions {
  const session = useChalkSession();
  return useMemo<ChalkSessionActions>(
    () => ({
      join: () => session.join(),
      leave: () => session.leave(),
      setMicrophoneEnabled: (enabled) => session.setMicrophoneEnabled(enabled),
      setCameraEnabled: (enabled) => session.setCameraEnabled(enabled),
      startScreenShare: () => session.startScreenShare(),
      stopScreenShare: () => session.stopScreenShare(),
      setHandRaised: (raised) => session.setHandRaised(raised),
      setDisplayName: (displayName) => session.setDisplayName(displayName),
      setAdmissionPolicy: (policy) => session.setAdmissionPolicy(policy),
      assignRole: (participantId, role) => session.assignRole(participantId, role),
      assignOwner: (participantId) => session.assignOwner(participantId),
      admitParticipant: (admissionRequestId) => session.admitParticipant(admissionRequestId),
      denyAdmission: (admissionRequestId) => session.denyAdmission(admissionRequestId),
      muteParticipant: (participantId) => session.muteParticipant(participantId),
      stopParticipantCamera: (participantId) => session.stopParticipantCamera(participantId),
      stopParticipantScreenShare: (participantId) => session.stopParticipantScreenShare(participantId),
      removeParticipant: (participantId) => session.removeParticipant(participantId),
      endEpisode: () => session.endEpisode(),
      sendReaction: (reaction) => session.sendReaction(reaction),
      sendChatMessage: (input) => session.sendChatMessage(input),
      retryChatMessage: (clientMessageId) => session.retryChatMessage(clientMessageId),
      loadOlderChatMessages: (limit) => session.loadOlderChatMessages(limit),
      markChatRead: (throughSequence) => session.markChatRead(throughSequence),
      requestUnmute: (participantId) => session.requestUnmute(participantId),
      requestStartCamera: (participantId) => session.requestStartCamera(participantId),
      acceptMediaRequest: (requestId) => session.acceptMediaRequest(requestId),
      declineMediaRequest: (requestId) => session.declineMediaRequest(requestId),
    }),
    [session],
  );
}
