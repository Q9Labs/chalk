import type { ChalkChatMessage, ChalkPendingChatMessage, ChalkRoomReaction as ChalkReaction } from "@q9labsai/chalk-client";
import type { ConferencePanel as SpacePanel, Participant, ParticipantListParticipant, ReconnectingOverlayProps, SettingsDialogValue, ThemePalette, ThemeTexture, TranscriptEntry } from "@q9labsai/chalk-react/components";

import type { PreviewSearch } from "./preview-state";

export const SPACE_NAME = "Design review Space";
export const DISPLAY_NAME = "Hasan";
export const SPACE_LINK = "https://chalk.example/spaces/design-review";

export type GalleryParticipant = Participant & { readonly role: "host" | "co-host" | "participant" };

const PARTICIPANT_FIXTURES: readonly GalleryParticipant[] = [
  {
    id: "you",
    displayName: DISPLAY_NAME,
    isLocal: true,
    isMuted: false,
    isVideoEnabled: true,
    role: "host",
    connectionQuality: 4,
  },
  {
    id: "nora",
    displayName: "Nora Williams",
    isSpeaking: true,
    isMuted: false,
    isVideoEnabled: true,
    role: "co-host",
    connectionQuality: 4,
  },
  {
    id: "akash",
    displayName: "Akash Jain",
    isMuted: true,
    isVideoEnabled: false,
    isHandRaised: true,
    role: "participant",
    connectionQuality: 3,
  },
  {
    id: "sofia",
    displayName: "Sofia Chen",
    isMuted: false,
    isVideoEnabled: true,
    role: "participant",
    connectionQuality: 2,
  },
  {
    id: "malik",
    displayName: "Malik Brooks",
    isMuted: true,
    isVideoEnabled: true,
    role: "participant",
    connectionQuality: 4,
  },
];

export const INITIAL_CHAT_MESSAGES: readonly ChalkChatMessage[] = [
  {
    messageId: "preview-message-1",
    clientMessageId: "preview-client-1",
    sequence: "1",
    participantSessionId: "nora",
    displayName: "Nora Williams",
    text: "The new Space direction feels much calmer.",
    createdAt: "2026-08-01T10:12:00.000Z",
    attachments: [],
  },
  {
    messageId: "preview-message-2",
    clientMessageId: "preview-client-2",
    sequence: "2",
    participantSessionId: "you",
    displayName: DISPLAY_NAME,
    text: "Agreed. Let’s keep the controls out of the stage.",
    createdAt: "2026-08-01T10:13:00.000Z",
    attachments: [],
  },
  {
    messageId: "preview-message-3",
    clientMessageId: "preview-client-3",
    sequence: "3",
    participantSessionId: "sofia",
    displayName: "Sofia Chen",
    text: "I’ll share the revised agenda here after the Space.",
    createdAt: "2026-08-01T10:14:00.000Z",
    attachments: [],
  },
];

export const TRANSCRIPT_FIXTURES: readonly TranscriptEntry[] = [
  {
    id: "transcript-1",
    speaker: "Nora Williams",
    speakerId: "nora",
    text: "We can ship the first collaborative surface this week.",
    timestamp: new Date("2026-08-01T10:15:00.000Z"),
    isHost: true,
  },
  {
    id: "transcript-2",
    speaker: DISPLAY_NAME,
    speakerId: "you",
    text: "Let’s keep the Space controls calm and predictable.",
    timestamp: new Date("2026-08-01T10:15:08.000Z"),
    isLocalParticipant: true,
  },
];

export const WAITING_PARTICIPANTS = [
  { id: "guest-1", displayName: "Priya Shah", joinedAt: new Date("2026-08-01T10:14:00.000Z") },
  { id: "guest-2", displayName: "Eli Morgan", joinedAt: new Date("2026-08-01T10:16:00.000Z") },
];

export const INITIAL_SETTINGS: SettingsDialogValue = {
  identity: { displayName: DISPLAY_NAME },
  join: { videoEnabled: true, audioEnabled: true },
  audio: { selectedInput: "default-mic", selectedOutput: "default-speaker", outputVolume: 68, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
  video: { selectedInput: "default-camera", quality: "auto" },
  appearance: { layout: "focus", theme: "dark", palette: "warm-charcoal", texture: "paper", gradient: "default", showFilmstrip: true, reducedMotion: false, generatedAvatars: true, profileGradient: { mode: "auto" }, ambientBackground: false },
  experience: { captions: false, compactMode: false, showInviteToast: false, defaultOpenChat: false, defaultOpenParticipants: false, defaultOpenTranscription: false, autoOpenPictureInPicture: false },
};

export const TOAST_MESSAGES: Record<Exclude<PreviewSearch["toast"], "none">, string> = {
  info: "A new Participant joined this Space.",
  success: "The Space link is ready to share.",
  warning: "A Participant raised a hand.",
  error: "The Space connection is unstable.",
};

export const REACTIONS: readonly ChalkReaction[] = [{ eventId: "preview-reaction-1", participantSessionId: "nora", displayName: "Nora Williams", reaction: "🎉", occurredAt: "2026-08-01T10:15:00.000Z", expiresAt: "2026-08-01T10:16:00.000Z" }];

export function productionPalette(palette: PreviewSearch["palette"]): ThemePalette {
  switch (palette) {
    case "midnight":
      return "oled-signal";
    case "slate":
      return "cool-graphite";
    case "paper":
      return "light";
    default:
      return "warm-charcoal";
  }
}

export function productionTexture(texture: PreviewSearch["texture"]): ThemeTexture {
  switch (texture) {
    case "soft-dots":
      return "slate";
    case "none":
      return "none";
    default:
      return "paper";
  }
}

export function previewPalette(palette: ThemePalette): PreviewSearch["palette"] {
  switch (palette) {
    case "oled-signal":
      return "midnight";
    case "cool-graphite":
      return "slate";
    case "light":
      return "paper";
    default:
      return "warm-charcoal";
  }
}

export function previewTexture(texture: ThemeTexture): PreviewSearch["texture"] {
  switch (texture) {
    case "slate":
      return "soft-dots";
    case "none":
      return "none";
    default:
      return "soft-grid";
  }
}

export function participantsForCount(count: PreviewSearch["participants"], search: PreviewSearch): GalleryParticipant[] {
  return PARTICIPANT_FIXTURES.slice(0, count).map((participant, index) => ({
    ...participant,
    isMuted: index === 0 ? !search.mic : participant.isMuted,
    isVideoEnabled: index === 0 ? search.camera : participant.isVideoEnabled,
    isHandRaised: index === 0 ? search.hand : participant.isHandRaised,
    isScreenSharing: search.stage === "share" && participant.id === "nora",
  }));
}

export function toParticipantList(participants: readonly GalleryParticipant[]): ParticipantListParticipant[] {
  return participants.map((participant) => ({
    id: participant.id,
    displayName: participant.displayName,
    isLocal: participant.isLocal,
    isMuted: participant.isMuted,
    isVideoEnabled: participant.isVideoEnabled,
    isHandRaised: participant.isHandRaised,
    role: participant.role,
  }));
}

export function chatPending(search: PreviewSearch): readonly ChalkPendingChatMessage[] {
  if (search.chat === "pending") {
    return [{ clientMessageId: "preview-pending-1", text: "I’m sending the latest Space notes…", attachments: [], state: "sending", error: null }];
  }
  if (search.chat === "failure") {
    return [{ clientMessageId: "preview-failed-1", text: "Could not publish this update", attachments: [], state: "failed", error: { code: "internal_error", action: "sendChatMessage", recoverable: true, message: "Chat is temporarily unavailable." } }];
  }
  return [];
}

export type GalleryPanel = Exclude<SpacePanel, "settings">;

export function panelFor(search: PreviewSearch): GalleryPanel | null {
  if (search.panel === "none") return null;
  return search.panel as GalleryPanel;
}

export function statusOverlay(search: PreviewSearch, onRetry: () => void, onBack: () => void): (Omit<ReconnectingOverlayProps, "isVisible"> & { readonly isVisible: true }) | undefined {
  switch (search.state) {
    case "reconnecting":
      return { isVisible: true, status: "reconnecting" as const, message: "The Space connection was interrupted. Reconnecting now…", onRetry, onLeave: onBack };
    case "retry":
      return { isVisible: true, status: "failed" as const, message: "The Space connection needs another try.", supportCode: "space-retry-204", onRetry, onLeave: onBack };
    case "timeout":
      return { isVisible: true, status: "failed" as const, message: "The Space took too long to reconnect.", supportCode: "space-timeout-408", onRetry, onLeave: onBack };
    case "failure":
      return { isVisible: true, status: "failed" as const, message: "The Space connection failed before recovery completed.", supportCode: "space-failure-503", onRetry, onLeave: onBack };
    default:
      return undefined;
  }
}
