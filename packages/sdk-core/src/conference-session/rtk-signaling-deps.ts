import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { ChatMessage, Participant, SessionConnectionState } from "../types.ts";
import type { WSClient } from "../ws-client.ts";
import type { ConferenceSessionEvents, Transcript } from "./types.ts";

export interface RtkSignalingDeps {
  roomId: string;
  debug: boolean;
  isLeaving: () => boolean;
  getRtkClient: () => RealtimeKitClient | undefined;
  getWsClient: () => WSClient | undefined;
  getParticipants: () => Map<string, Participant>;
  getPeerIdMap: () => Map<string, string>;
  getLocalParticipant: () => Participant | null;
  getActiveSpeaker: () => Participant | null;
  setActiveSpeaker: (participant: Participant | null) => void;
  getMessages: () => ChatMessage[];
  getTranscripts: () => Transcript[];
  setConnectionState: (state: SessionConnectionState) => void;
  emitRoomSyncReady: (source: "rtk.snapshot" | "ws.snapshot", participantCount: number) => void;
  emit: <K extends keyof ConferenceSessionEvents>(event: K, data: ConferenceSessionEvents[K]) => void;
  validateTrack: (track: MediaStreamTrack | undefined | null, type: string, participantId: string) => boolean;
  logConnectionState: () => void;
  hasSelectedBackgroundEffect?: () => boolean;
  reapplyBackgroundEffect?: () => Promise<unknown>;
  suspendBackgroundEffect?: () => Promise<unknown>;
}
