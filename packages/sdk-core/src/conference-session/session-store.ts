import type { ChatMessage, Participant } from "../types.ts";
import type { Transcript } from "./types.ts";

interface ConferenceSessionStoreBindings {
  getParticipants: () => Map<string, Participant>;
  getPeerIdMap: () => Map<string, string>;
  getMessages: () => ChatMessage[];
  setMessages: (messages: ChatMessage[]) => void;
  getTranscripts: () => Transcript[];
  setTranscripts: (transcripts: Transcript[]) => void;
  getWhiteboardPermissions: () => Map<string, boolean>;
  getLocalParticipant: () => Participant | null;
  setLocalParticipant: (participant: Participant | null) => void;
  getActiveSpeaker: () => Participant | null;
  setActiveSpeaker: (participant: Participant | null) => void;
  getCurrentRecording: () => { id: string } | null;
  setCurrentRecording: (recording: { id: string } | null) => void;
}

export interface ConferenceSessionStore {
  getParticipants: () => Map<string, Participant>;
  getPeerIdMap: () => Map<string, string>;
  getMessages: () => ChatMessage[];
  setMessages: (messages: ChatMessage[]) => void;
  getTranscripts: () => Transcript[];
  getLocalParticipant: () => Participant | null;
  getActiveSpeaker: () => Participant | null;
  getCurrentRecording: () => { id: string } | null;
  getWhiteboardPermission: (participantId: string) => boolean | undefined;
  setParticipant: (participantId: string, participant: Participant) => void;
  deleteParticipant: (participantId: string) => boolean;
  appendMessage: (message: ChatMessage) => void;
  appendTranscript: (transcript: Transcript) => void;
  setWhiteboardPermission: (participantId: string, canDraw: boolean) => void;
  setLocalParticipant: (participant: Participant | null) => void;
  setActiveSpeaker: (participant: Participant | null) => void;
  setCurrentRecording: (recording: { id: string } | null) => void;
  clearRuntimeState: () => void;
}

export const createConferenceSessionStore = (bindings: ConferenceSessionStoreBindings): ConferenceSessionStore => {
  const getParticipants = (): Map<string, Participant> => bindings.getParticipants();
  const getPeerIdMap = (): Map<string, string> => bindings.getPeerIdMap();
  const getMessages = (): ChatMessage[] => bindings.getMessages();
  const getTranscripts = (): Transcript[] => bindings.getTranscripts();
  const getLocalParticipant = (): Participant | null => bindings.getLocalParticipant();
  const getActiveSpeaker = (): Participant | null => bindings.getActiveSpeaker();
  const getCurrentRecording = (): { id: string } | null => bindings.getCurrentRecording();
  const getWhiteboardPermission = (participantId: string): boolean | undefined => bindings.getWhiteboardPermissions().get(participantId);

  const setParticipant = (participantId: string, participant: Participant): void => {
    bindings.getParticipants().set(participantId, participant);
  };

  const deleteParticipant = (participantId: string): boolean => bindings.getParticipants().delete(participantId);

  const appendMessage = (message: ChatMessage): void => {
    bindings.getMessages().push(message);
  };

  const appendTranscript = (transcript: Transcript): void => {
    bindings.getTranscripts().push(transcript);
  };

  const setWhiteboardPermission = (participantId: string, canDraw: boolean): void => {
    bindings.getWhiteboardPermissions().set(participantId, canDraw);
  };

  const setLocalParticipant = (participant: Participant | null): void => {
    bindings.setLocalParticipant(participant);
  };

  const setActiveSpeaker = (participant: Participant | null): void => {
    bindings.setActiveSpeaker(participant);
  };

  const setCurrentRecording = (recording: { id: string } | null): void => {
    bindings.setCurrentRecording(recording);
  };

  const clearRuntimeState = (): void => {
    bindings.getParticipants().clear();
    bindings.getPeerIdMap().clear();
    bindings.setActiveSpeaker(null);
    bindings.setMessages([]);
    bindings.setTranscripts([]);
    bindings.setCurrentRecording(null);
    bindings.setLocalParticipant(null);
  };

  return {
    getParticipants,
    getPeerIdMap,
    getMessages,
    setMessages: bindings.setMessages,
    getTranscripts,
    getLocalParticipant,
    getActiveSpeaker,
    getCurrentRecording,
    getWhiteboardPermission,
    setParticipant,
    deleteParticipant,
    appendMessage,
    appendTranscript,
    setWhiteboardPermission,
    setLocalParticipant,
    setActiveSpeaker,
    setCurrentRecording,
    clearRuntimeState,
  };
};
