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

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName?: string;
  text: string;
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
  wideEvents?: {
    enabled?: boolean;
    includeDebugInfo?: boolean;
    handler?: ((event: unknown) => void) | null;
  };
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

export class ChalkErrorClass extends Error {
  static wrap(cause: unknown): ChalkErrorClass {
    if (cause instanceof ChalkErrorClass) {
      return cause;
    }
    if (cause instanceof Error) {
      return new ChalkErrorClass(cause.message);
    }
    return new ChalkErrorClass(String(cause));
  }
}

export type ChalkError = ChalkErrorClass;

const emptyRoomState: RoomState = {
  id: null,
  status: "disconnected",
  error: null,
  roomId: null,
  roomName: null,
  isJoining: false,
  hostId: null,
};

function createManager<State>(state: State): any {
  return {
    getState: () => state,
    subscribe: () => () => {},
    getRoom: () => state,
    getParticipant: () => undefined,
    remoteParticipants: [],
    updateDisplayName: async () => {},
    join: async () => {},
    leave: async () => {},
    start: async () => false,
    stop: async () => {},
    toggle: async () => false,
    mute: async () => {},
    unmute: async () => {},
    refreshDevices: async () => [],
    applyBackgroundEffect: async () => {},
    sendReaction: () => {},
    raiseHand: () => {},
    lowerHand: () => {},
    sendMessage: () => {},
    reactToMessage: () => {},
    getMessage: () => undefined,
    clearUnread: () => {},
    startRecording: async () => {},
    stopRecording: async () => {},
    openPanel: () => {},
    closePanel: () => {},
    togglePanel: () => {},
    setLayout: () => {},
    openWhiteboard: () => {},
    closeWhiteboard: () => {},
    on: () => {},
    off: () => {},
  };
}

export class ChalkSession {
  readonly room = createManager(emptyRoomState);
  readonly participants = createManager({ participants: [], localParticipant: null, activeSpeaker: null, count: 0 } satisfies ParticipantState);
  readonly media = createManager({
    devices: [],
    cameras: [],
    microphones: [],
    speakers: [],
    selectedCameraId: null,
    selectedMicrophoneId: null,
    selectedSpeakerId: null,
    selectedBackgroundEffect: { id: "none", type: "none" },
    selectedCamera: null,
    selectedMicrophone: null,
    selectedSpeaker: null,
    isBackgroundEffectsSupported: false,
    isApplyingBackgroundEffect: false,
    isVideoEnabled: false,
    isAudioEnabled: false,
    isTogglingVideo: false,
    isTogglingAudio: false,
  } satisfies MediaState);
  readonly screenShare = createManager({ isActive: false, isLocalSharing: false, isStarting: false, sharerParticipantId: null, videoTrack: null, audioTrack: null } satisfies ScreenShareState);
  readonly interactions = createManager({ handRaised: false, isHandRaised: false, raisedHandCount: 0, raisedHands: [], activeReactions: [] } satisfies InteractionState);
  readonly chat = createManager({ messages: [], unreadCount: 0, isEnabled: false, count: 0 } satisfies ChatState);
  readonly recording = createManager({ isRecording: false, isStarting: false, isStopping: false, recordingId: null, startedAt: null } satisfies RecordingState);
  readonly ui = createManager({ layout: "grid", activePanel: null, controlsVisible: true, isMobileView: false, isFullscreen: false } satisfies UIState);
  readonly whiteboard = createManager({ isOpen: false, cursors: [], openParticipants: [], canDraw: false, elements: [], elementCount: 0, lastSeq: 0 } satisfies WhiteboardState);

  constructor(_config?: unknown) {}

  configureIncident(_config?: IncidentConfig): void {}
  dispose(): void {}
  preloadRealtimeKit(): Promise<void> {
    return Promise.resolve();
  }
  on(_event: string, _handler: (...args: any[]) => void): () => void {
    return () => {};
  }
  join(_roomId: string, _options: JoinOptions): Promise<void> {
    return Promise.resolve();
  }
  leave(_options?: LeaveOptions): Promise<void> {
    return Promise.resolve();
  }
  createSession(_name?: string): Promise<string> {
    return Promise.resolve("");
  }
  createJoinToken(_roomId?: string): Promise<{ joinToken: string }> {
    return Promise.resolve({ joinToken: "" });
  }
  endSession(_roomId: string): Promise<void> {
    return Promise.resolve();
  }
  getDiagnosticsSnapshot(): ChalkSessionDiagnosticsSnapshot {
    return { websocketConnectionState: "disconnected" };
  }
  updateOwnDisplayName(_displayName: string): Promise<void> {
    return Promise.resolve();
  }
  removeParticipant(_participantId: string): Promise<void> {
    return Promise.resolve();
  }
  muteParticipant(_participantId: string): void {}
  unmuteParticipant(_participantId: string): void {}
}

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
