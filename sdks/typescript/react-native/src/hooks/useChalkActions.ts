import type { ChalkSessionActions } from "@q9labsai/chalk-client";
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
      setParticipantRole: (participantSessionId, role) => session.setParticipantRole(participantSessionId, role),
      transferHost: (participantSessionId) => session.transferHost(participantSessionId),
      admitParticipant: (admissionRequestId) => session.admitParticipant(admissionRequestId),
      denyAdmission: (admissionRequestId) => session.denyAdmission(admissionRequestId),
      muteParticipant: (participantSessionId) => session.muteParticipant(participantSessionId),
      stopParticipantCamera: (participantSessionId) => session.stopParticipantCamera(participantSessionId),
      stopParticipantScreenShare: (participantSessionId) => session.stopParticipantScreenShare(participantSessionId),
      removeParticipant: (participantSessionId) => session.removeParticipant(participantSessionId),
      endSession: () => session.endSession(),
      sendReaction: (reaction) => session.sendReaction(reaction),
      sendChatMessage: (input) => session.sendChatMessage(input),
      retryChatMessage: (clientMessageId) => session.retryChatMessage(clientMessageId),
      loadOlderChatMessages: (limit) => session.loadOlderChatMessages(limit),
      markChatRead: (throughSequence) => session.markChatRead(throughSequence),
      requestUnmute: (participantSessionId) => session.requestUnmute(participantSessionId),
      requestStartCamera: (participantSessionId) => session.requestStartCamera(participantSessionId),
      acceptMediaRequest: (requestId) => session.acceptMediaRequest(requestId),
      declineMediaRequest: (requestId) => session.declineMediaRequest(requestId),
    }),
    [session],
  );
}
