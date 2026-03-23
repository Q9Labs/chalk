import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ChalkError, Participant, Transcript } from "@q9labs/chalk-core";
import type { ComponentType, ReactNode } from "react";

export type Phase = "lobby" | "joining" | "meeting" | "end";

export interface FeatureContext {
  participants: readonly Participant[];
  localParticipant: Participant | null;
  participantCount: number;
  isRecording: boolean;
}

export type FeatureValue = boolean | ((ctx: FeatureContext) => boolean);

export interface Features {
  chat?: FeatureValue;
  recording?: FeatureValue;
  screenShare?: FeatureValue;
  whiteboard?: FeatureValue;
  reactions?: FeatureValue;
  handRaise?: FeatureValue;
  backgroundEffects?: FeatureValue;
  pictureInPicture?: FeatureValue;
  tour?: FeatureValue;
}

interface LobbySlots {
  header?: ReactNode;
  footer?: ReactNode;
}

interface EndScreenSlots {
  actions?: ReactNode;
}

interface Slots {
  header?: ReactNode | ((DefaultHeader: ComponentType) => ReactNode);
  controls?: ReactNode | ((DefaultControls: ComponentType) => ReactNode);
  sidebar?: ReactNode | ((DefaultSidebar: ComponentType) => ReactNode);
  videoGrid?: ReactNode | ((DefaultVideoGrid: ComponentType) => ReactNode);
  lobby?: LobbySlots;
  endScreen?: EndScreenSlots;
}

interface Defaults {
  layout?: "grid" | "spotlight" | "sidebar";
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  chatOpen?: boolean;
  participantsOpen?: boolean;
}

interface Theme {
  accentColor?: string;
  borderRadius?: "rounded" | "sharp";
}

export interface MeetingJoinedData {
  roomId: string;
  participantId: string;
  role: string;
  displayName: string;
  isRecording: boolean;
  joinedAt: Date;
}

export interface ParticipantSession {
  id: string;
  externalId: string | null;
  displayName: string;
  role: "host" | "participant";
  joinedAt: Date;
  leftAt: Date | null;
}

export interface MeetingStats {
  chatMessageCount: number;
  reactionCount: number;
  handRaiseCount: number;
  screenShareCount: number;
  whiteboardOpened: boolean;
  recordingDuration: number;
}

export interface MeetingEndData {
  roomId: string;
  duration: number;
  transcripts: Transcript[];
  recordingId: string | null;
  participantCount: number;
  totalParticipants: number;
  participants: ParticipantSession[];
  hostId: string | null;
  startedAt: Date;
  endedAt: Date;
  stats: MeetingStats;
}

export interface VideoConferenceProps {
  roomId?: string;
  joinToken?: string;
  inviteLink?: string;
  roomName?: string;
  meetingLink?: string;
  userName: string;
  autoJoin?: boolean;
  role?: "host" | "participant";
  metadata?: Record<string, unknown>;
  features?: Features;
  defaults?: Defaults;
  theme?: Theme;
  shortcuts?: Record<string, string>;
  sounds?: boolean;
  debug?: boolean;
  slots?: Slots;
  onJoin?: (data: MeetingJoinedData) => void;
  onLeave?: () => void;
  onEnd?: (data: MeetingEndData) => void;
  onError?: (error: ChalkError) => void;
  onAddPeople?: () => void;
  whiteboard?: {
    onExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
  };
  className?: string;
}
