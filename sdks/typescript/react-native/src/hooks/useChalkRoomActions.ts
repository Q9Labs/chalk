import type { ChalkSessionActions, ChalkSessionSnapshot } from "@q9labsai/chalk-client";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { useChalkSessionStore } from "../context/chalk-native-provider";

export type ChalkSelector<T> = (snapshot: ChalkSessionSnapshot) => T;

const subscribeToNothing = () => () => undefined;
const getMissingSnapshot = () => null;

export function useOptionalChalkSnapshot(): ChalkSessionSnapshot | null {
  const store = useChalkSessionStore();
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? subscribeToNothing(), [store]);
  const getSnapshot = useCallback(() => store?.getSnapshot() ?? getMissingSnapshot(), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useChalkSelector<T>(selector: ChalkSelector<T>): T {
  const snapshot = useOptionalChalkSnapshot();
  if (!snapshot) {
    throw new Error("ChalkNativeProvider requires sessionStore for Sync v3 room actions.");
  }
  return selector(snapshot);
}

export function useChalkActions(): ChalkSessionActions {
  const store = useChalkSessionStore();
  const actions = useMemo<ChalkSessionActions | null>(
    () =>
      store
        ? {
            join: () => store.join(),
            leave: () => store.leave(),
            setMicrophoneEnabled: (enabled) => store.setMicrophoneEnabled(enabled),
            setCameraEnabled: (enabled) => store.setCameraEnabled(enabled),
            startScreenShare: () => store.startScreenShare(),
            stopScreenShare: () => store.stopScreenShare(),
            setHandRaised: (raised) => store.setHandRaised(raised),
            setDisplayName: (displayName) => store.setDisplayName(displayName),
            setAdmissionPolicy: (policy) => store.setAdmissionPolicy(policy),
            setParticipantRole: (participantSessionId, role) => store.setParticipantRole(participantSessionId, role),
            transferHost: (participantSessionId) => store.transferHost(participantSessionId),
            admitParticipant: (admissionRequestId) => store.admitParticipant(admissionRequestId),
            denyAdmission: (admissionRequestId) => store.denyAdmission(admissionRequestId),
            muteParticipant: (participantSessionId) => store.muteParticipant(participantSessionId),
            stopParticipantCamera: (participantSessionId) => store.stopParticipantCamera(participantSessionId),
            stopParticipantScreenShare: (participantSessionId) => store.stopParticipantScreenShare(participantSessionId),
            removeParticipant: (participantSessionId) => store.removeParticipant(participantSessionId),
            endSession: () => store.endSession(),
            sendReaction: (reaction) => store.sendReaction(reaction),
            sendChatMessage: (input) => store.sendChatMessage(input),
            retryChatMessage: (clientMessageId) => store.retryChatMessage(clientMessageId),
            loadOlderChatMessages: (limit) => store.loadOlderChatMessages(limit),
            markChatRead: () => store.markChatRead(),
            requestUnmute: (participantSessionId) => store.requestUnmute(participantSessionId),
            requestStartCamera: (participantSessionId) => store.requestStartCamera(participantSessionId),
            acceptMediaRequest: (requestId) => store.acceptMediaRequest(requestId),
            declineMediaRequest: (requestId) => store.declineMediaRequest(requestId),
          }
        : null,
    [store],
  );
  if (!actions) {
    throw new Error("ChalkNativeProvider requires sessionStore for Sync v3 room actions.");
  }
  return actions;
}
