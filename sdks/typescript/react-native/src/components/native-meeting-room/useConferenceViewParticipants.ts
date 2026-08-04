import type { ChalkAssignableParticipantRole, ChalkSessionSnapshot, ChalkSessionStore } from "../../client-compat";
import { useEffect, useRef } from "react";
import { Alert } from "react-native";

import { createNativeMediaRequestPrompt, type NativeActionCommands } from "../../room-actions/native-room-actions";
import type { UseMeetingParticipantsReturn } from "../../hooks/useMeetingParticipants";
import type { ConferenceViewActionRunner } from "./types";

export interface ConferenceViewParticipants {
  readonly isHost: boolean;
  readonly selfName: string;
  readonly participantCount: number;
  readonly admissionRequests: ChalkSessionSnapshot["admissionRequests"];
  readonly participants: UseMeetingParticipantsReturn;
  readonly admitParticipant: (admissionRequestId: string) => void;
  readonly denyAdmission: (admissionRequestId: string) => void;
  readonly setParticipantRole: (participantId: string, role: ChalkAssignableParticipantRole) => void;
  readonly transferHost: (participantId: string) => void;
  readonly removeParticipant: (participantId: string) => void;
  readonly muteParticipant: (participantId: string) => void;
  readonly requestUnmuteParticipant: (participantId: string) => void;
  readonly requestStartParticipantCamera: (participantId: string) => void;
  readonly stopParticipantCamera: (participantId: string) => void;
  readonly stopParticipantScreenShare: (participantId: string) => void;
}

interface UseConferenceViewParticipantsOptions {
  readonly isHost: boolean;
  readonly snapshot: Pick<ChalkSessionSnapshot, "incomingMediaRequests" | "admissionRequests">;
  readonly session: Pick<ChalkSessionStore, "admitParticipant" | "denyAdmission" | "assignRole" | "assignOwner" | "removeParticipant" | "muteParticipant" | "requestUnmute" | "requestStartCamera" | "stopParticipantCamera" | "stopParticipantScreenShare">;
  readonly participants: UseMeetingParticipantsReturn;
  readonly commands: NativeActionCommands;
  readonly run: ConferenceViewActionRunner;
}

export function useConferenceViewParticipants({ isHost, snapshot, session, participants, commands, run }: UseConferenceViewParticipantsOptions): ConferenceViewParticipants {
  const promptedRequestId = useRef<string | null>(null);

  useEffect(() => {
    const request = snapshot.incomingMediaRequests[0];
    if (!request || promptedRequestId.current === request.requestId) return;
    promptedRequestId.current = request.requestId;
    const prompt = createNativeMediaRequestPrompt(request, commands, (cause) => {
      Alert.alert("Request failed", cause instanceof Error ? cause.message : "The media request could not be applied.");
    });
    Alert.alert(prompt.title, prompt.message, [...prompt.buttons]);
  }, [commands, snapshot.incomingMediaRequests]);

  return {
    isHost,
    selfName: participants.localParticipant?.displayName || "Guest",
    participantCount: participants.participantCount,
    admissionRequests: snapshot.admissionRequests,
    participants,
    admitParticipant: (admissionRequestId: string) => void run(() => session.admitParticipant(admissionRequestId)),
    denyAdmission: (admissionRequestId: string) => void run(() => session.denyAdmission(admissionRequestId)),
    setParticipantRole: (participantId: string, role: ChalkAssignableParticipantRole) => void run(() => session.assignRole(participantId, role)),
    transferHost: (participantId: string) => void run(() => session.assignOwner(participantId)),
    removeParticipant: (participantId: string) => void run(() => session.removeParticipant(participantId)),
    muteParticipant: (participantId: string) => void run(() => session.muteParticipant(participantId)),
    requestUnmuteParticipant: (participantId: string) => void run(() => session.requestUnmute(participantId)),
    requestStartParticipantCamera: (participantId: string) => void run(() => session.requestStartCamera(participantId)),
    stopParticipantCamera: (participantId: string) => void run(() => session.stopParticipantCamera(participantId)),
    stopParticipantScreenShare: (participantId: string) => void run(() => session.stopParticipantScreenShare(participantId)),
  };
}
