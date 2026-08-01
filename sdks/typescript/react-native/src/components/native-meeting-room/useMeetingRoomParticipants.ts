import type { ChalkAssignableParticipantRole, ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { useEffect, useRef } from "react";
import { Alert } from "react-native";

import { createNativeMediaRequestPrompt, type NativeRoomActionCommands } from "../../room-actions/native-room-actions";
import type { UseMeetingParticipantsReturn } from "../../hooks/useMeetingParticipants";
import type { MeetingRoomActionRunner } from "./types";

export interface MeetingRoomParticipants {
  readonly isHost: boolean;
  readonly selfName: string;
  readonly participantCount: number;
  readonly admissionRequests: ChalkSessionSnapshot["admissionRequests"];
  readonly participants: UseMeetingParticipantsReturn;
  readonly admitParticipant: (admissionRequestId: string) => void;
  readonly denyAdmission: (admissionRequestId: string) => void;
  readonly setParticipantRole: (participantSessionId: string, role: ChalkAssignableParticipantRole) => void;
  readonly transferHost: (participantSessionId: string) => void;
  readonly removeParticipant: (participantSessionId: string) => void;
  readonly muteParticipant: (participantSessionId: string) => void;
  readonly requestUnmuteParticipant: (participantSessionId: string) => void;
  readonly requestStartParticipantCamera: (participantSessionId: string) => void;
  readonly stopParticipantCamera: (participantSessionId: string) => void;
  readonly stopParticipantScreenShare: (participantSessionId: string) => void;
}

interface UseMeetingRoomParticipantsOptions {
  readonly isHost: boolean;
  readonly snapshot: Pick<ChalkSessionSnapshot, "incomingMediaRequests" | "admissionRequests">;
  readonly session: Pick<ChalkSessionStore, "admitParticipant" | "denyAdmission" | "setParticipantRole" | "transferHost" | "removeParticipant" | "muteParticipant" | "requestUnmute" | "requestStartCamera" | "stopParticipantCamera" | "stopParticipantScreenShare">;
  readonly participants: UseMeetingParticipantsReturn;
  readonly commands: NativeRoomActionCommands;
  readonly run: MeetingRoomActionRunner;
}

export function useMeetingRoomParticipants({ isHost, snapshot, session, participants, commands, run }: UseMeetingRoomParticipantsOptions): MeetingRoomParticipants {
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
    setParticipantRole: (participantSessionId: string, role: ChalkAssignableParticipantRole) => void run(() => session.setParticipantRole(participantSessionId, role)),
    transferHost: (participantSessionId: string) => void run(() => session.transferHost(participantSessionId)),
    removeParticipant: (participantSessionId: string) => void run(() => session.removeParticipant(participantSessionId)),
    muteParticipant: (participantSessionId: string) => void run(() => session.muteParticipant(participantSessionId)),
    requestUnmuteParticipant: (participantSessionId: string) => void run(() => session.requestUnmute(participantSessionId)),
    requestStartParticipantCamera: (participantSessionId: string) => void run(() => session.requestStartCamera(participantSessionId)),
    stopParticipantCamera: (participantSessionId: string) => void run(() => session.stopParticipantCamera(participantSessionId)),
    stopParticipantScreenShare: (participantSessionId: string) => void run(() => session.stopParticipantScreenShare(participantSessionId)),
  };
}
