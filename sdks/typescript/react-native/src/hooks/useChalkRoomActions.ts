import type { ChalkSessionActions, ChalkSessionSnapshot } from "@q9labsai/chalk-client";
import { useMemo, useSyncExternalStore } from "react";

import { useChalkSession } from "../context/chalk-native-provider";

export type ChalkSelector<T> = (snapshot: ChalkSessionSnapshot) => T;

export function useChalkSnapshot(): ChalkSessionSnapshot {
  const session = useChalkSession();
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

export function useChalkSelector<T>(selector: ChalkSelector<T>): T {
  return selector(useChalkSnapshot());
}

export function useChalkActions(): ChalkSessionActions {
  const session = useChalkSession();
  return useMemo<ChalkSessionActions>(
    () => ({
      join: session.join,
      leave: session.leave,
      setMicrophoneEnabled: session.setMicrophoneEnabled,
      setCameraEnabled: session.setCameraEnabled,
      startScreenShare: session.startScreenShare,
      stopScreenShare: session.stopScreenShare,
      setHandRaised: session.setHandRaised,
      setDisplayName: session.setDisplayName,
      setAdmissionPolicy: session.setAdmissionPolicy,
      setParticipantRole: session.setParticipantRole,
      transferHost: session.transferHost,
      admitParticipant: session.admitParticipant,
      denyAdmission: session.denyAdmission,
      muteParticipant: session.muteParticipant,
      stopParticipantCamera: session.stopParticipantCamera,
      stopParticipantScreenShare: session.stopParticipantScreenShare,
      removeParticipant: session.removeParticipant,
      endSession: session.endSession,
      sendReaction: session.sendReaction,
      sendChatMessage: session.sendChatMessage,
      retryChatMessage: session.retryChatMessage,
      loadOlderChatMessages: session.loadOlderChatMessages,
      markChatRead: session.markChatRead,
      requestUnmute: session.requestUnmute,
      requestStartCamera: session.requestStartCamera,
      acceptMediaRequest: session.acceptMediaRequest,
      declineMediaRequest: session.declineMediaRequest,
    }),
    [session],
  );
}
