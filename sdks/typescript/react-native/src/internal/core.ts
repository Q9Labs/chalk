import type { NativeSessionTelemetry } from "../telemetry";

export type ReactionEmoji = string;
export type LayoutMode = "grid" | "speaker" | "sidebar" | string;
export type PanelType = "chat" | "participants" | "transcripts" | "settings" | "whiteboard" | null;
export type ParticipantGradientPreference = "auto" | "subtle" | "vivid" | "mono" | string;

export interface Participant {
  id: string;
  displayName: string;
  role?: "host" | "participant" | string;
  audioEnabled?: boolean;
  videoEnabled?: boolean;
  handRaised?: boolean;
  audioLevel?: number;
  audioTrack?: MediaStreamTrack | null;
  videoTrack?: MediaStreamTrack | null;
  screenShareTrack?: MediaStreamTrack | null;
  [key: string]: any;
}

export interface ParticipantState {
  participants: readonly Participant[];
  localParticipant: Participant | null;
  activeSpeaker: Participant | null;
  count: number;
}

export interface RoomState {
  id: string | null;
  status: "connecting" | "connected" | "disconnected" | "failed" | "reconnecting";
  error: string | null;
  roomId: string | null;
  roomName: string | null;
  isJoining: boolean;
  hostId: string | null;
  [key: string]: any;
}

export interface JoinOptions {
  userName: string;
  [key: string]: any;
}

export interface LeaveOptions {
  reason?: string;
  [key: string]: any;
}

export interface MediaDevice {
  id: string;
  label: string;
  kind: "camera" | "microphone" | "speaker" | string;
  [key: string]: any;
}

export interface VideoBackgroundEffect {
  id: string;
  type: string;
  [key: string]: any;
}

export interface MediaState {
  devices: readonly MediaDevice[];
  cameras: readonly MediaDevice[];
  microphones: readonly MediaDevice[];
  speakers: readonly MediaDevice[];
  selectedCameraId: string | null;
  selectedMicrophoneId: string | null;
  selectedSpeakerId: string | null;
  selectedBackgroundEffect: VideoBackgroundEffect;
  selectedCamera: string | null;
  selectedMicrophone: string | null;
  selectedSpeaker: string | null;
  isBackgroundEffectsSupported: boolean;
  isApplyingBackgroundEffect: boolean;
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  isTogglingVideo: boolean;
  isTogglingAudio: boolean;
  [key: string]: any;
}

export interface ScreenShareOptions {
  [key: string]: any;
}

export interface ScreenShareState {
  isActive: boolean;
  isLocalSharing: boolean;
  isStarting: boolean;
  sharerParticipantId: string | null;
  videoTrack: MediaStreamTrack | null;
  audioTrack: MediaStreamTrack | null;
}

export interface ActiveReaction {
  id: string;
  emoji: ReactionEmoji;
  participantId: string;
  participantName: string;
  [key: string]: any;
}

export interface InteractionState {
  handRaised: boolean;
  isHandRaised: boolean;
  raisedHandCount: number;
  raisedHands: readonly string[];
  activeReactions: readonly ActiveReaction[];
}

export interface ChatAttachment {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
}

export interface ChatReadReceipt {
  participantSessionId: string;
  participantSessionGeneration: number;
  displayName: string;
  readThroughSequence: string;
  readAt: string;
}

export interface ChatMessage {
  id: string;
  sequence: string;
  senderId: string;
  senderName?: string;
  text: string;
  content: string;
  attachments: readonly ChatAttachment[];
  readBy: readonly ChatReadReceipt[];
  timestamp?: number;
  reactions?: Record<string, ReactionEmoji[]>;
  [key: string]: any;
}

export interface ChatState {
  messages: readonly ChatMessage[];
  unreadCount: number;
  isEnabled: boolean;
  count: number;
}

export interface Transcript {
  id: string;
  participantId?: string;
  participantName?: string;
  text: string;
  timestamp?: number;
  [key: string]: any;
}

export interface RecordingState {
  isRecording: boolean;
  isStarting: boolean;
  isStopping: boolean;
  recordingId: string | null;
  startedAt: number | null;
  [key: string]: any;
}

export interface WhiteboardCursor {
  participantId: string;
  x: number;
  y: number;
  [key: string]: any;
}

export interface WhiteboardUpdate {
  id?: string;
  [key: string]: any;
}

export interface WhiteboardSnapshot {
  id?: string;
  [key: string]: any;
}

export interface WhiteboardState {
  isOpen: boolean;
  cursors: readonly WhiteboardCursor[];
  openParticipants: readonly string[];
  canDraw: boolean;
  elements: readonly unknown[];
  elementCount?: number;
  lastSeq: number;
}

export interface UIState {
  layout: LayoutMode;
  activePanel: PanelType;
  controlsVisible: boolean;
  isMobileView: boolean;
  isFullscreen: boolean;
}

export interface ChalkIncident {
  message?: string;
  [key: string]: any;
}

export interface IncidentReporter {
  report: (incident: ChalkIncident) => void | Promise<void>;
}

export interface ConferenceClientConfig {
  telemetry?: NativeSessionTelemetry;
  wideEvents?: {
    enabled?: boolean;
    includeDebugInfo?: boolean;
    handler?: ((event: unknown) => void) | null;
  };
}

export interface ChalkSessionConfig extends ConferenceClientConfig {
  apiUrl: string;
  wsUrl?: string;
  token?: string;
  tokenProvider?: () => Promise<string>;
  dynamicTransportCredentials?: ReadonlySet<string>;
  apiKey?: string;
  debug?: boolean;
  demoMode?: boolean;
  realtimeKitLoader?: () => Promise<unknown>;
}

export interface IncidentConfig {
  onIncident?: (incident: ChalkIncident) => void;
  reporter?: IncidentReporter;
  maxBreadcrumbs?: number;
  [key: string]: any;
}

export interface ChalkSessionDiagnosticsSnapshot {
  websocketLastClose?: {
    reason?: string;
  };
  websocketConnectionState: "connecting" | "connected" | "disconnected" | "failed" | "reconnecting";
  [key: string]: any;
}

export { ChalkErrorClass, type ChalkError } from "./chalk-error";
export { ChalkSession } from "./realtimekit-runtime";

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

const palettes = [
  ["#14b8a6", "#0f766e", "#99f6e4"],
  ["#f59e0b", "#b45309", "#fde68a"],
  ["#ec4899", "#be185d", "#fbcfe8"],
  ["#8b5cf6", "#6d28d9", "#ddd6fe"],
  ["#06b6d4", "#0e7490", "#cffafe"],
  ["#22c55e", "#15803d", "#bbf7d0"],
] as const;

export function getParticipantColor(seed = "guest", _preference?: ParticipantGradientPreference) {
  const palette = palettes[hashString(seed) % palettes.length] ?? palettes[0];
  return {
    primary: palette[0],
    gradientEnd: palette[1],
    surface: palette[2],
  };
}

export function getParticipantAvatarRecipe(seed = "guest", preference?: ParticipantGradientPreference) {
  const colors = getParticipantColor(seed, preference);
  return {
    colors,
    gradientStops: [
      { color: colors.primary, offset: "0%" },
      { color: colors.gradientEnd, offset: "100%" },
    ],
    facehashColors: [colors.primary, colors.gradientEnd, colors.surface],
  };
}
