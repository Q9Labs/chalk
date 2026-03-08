import type { AppState } from "@q9labs/chalk-whiteboard/collab";
import type { ChalkError, ChatMessage, Participant, Reaction, Recording, SessionConnectionState } from "../types.ts";

/** Real-time transcript entry from speech-to-text */
export interface Transcript {
  id: string;
  participantId: string;
  speakerName: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
}

export interface WhiteboardUpdateEvent {
  schemaVersion: 2;
  sceneId: string;
  syncAll: boolean;
  participantId: string;
  displayName: string;
  elements: unknown[];
  files?: Record<string, unknown>;
  seq: number;
}

export interface WhiteboardSnapshotEvent {
  schemaVersion: 2;
  roomId: string;
  sceneId: string;
  elements: unknown[];
  files: Record<string, unknown>;
  appState: AppState;
  updatedAtMs?: number;
  lastSeq: number;
}

export interface WhiteboardCursorEvent {
  participantId: string;
  displayName: string;
  x: number;
  y: number;
}

export interface ConferenceSessionEvents {
  "connection.state.changed": SessionConnectionState;
  "participant.joined": Participant;
  "participant.left": string;
  "participant.updated": { participantId: string; participant: Participant };
  "speaker.active.changed": Participant | null;
  "chat.message": ChatMessage;
  "chat.read": {
    messageIds: string[];
    participantId: string;
    displayName: string;
    readAt: Date;
  };
  reaction: Reaction;
  "hand.raised": { participantId: string };
  "hand.lowered": { participantId: string };
  "recording.started": { recordingId: string };
  "recording.stopped": Recording;
  transcript: Transcript;
  error: ChalkError;
  "whiteboard.update": WhiteboardUpdateEvent;
  "whiteboard.snapshot": WhiteboardSnapshotEvent;
  "whiteboard.cursor": WhiteboardCursorEvent;
  "whiteboard.permission.changed": {
    participantId: string;
    canDraw: boolean;
  };
  "whiteboard.opened": {
    participantId: string;
    displayName: string;
  };
  "whiteboard.closed": {
    participantId: string;
  };
}
