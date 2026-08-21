import type { Capability, ChalkChatMessage, ChalkReactionEvent, RemoteMedia, SpaceSnapshot } from "@q9labsai/chalk-client";
import type { SpacePanel, ThemePalette, ThemeTexture } from "../../../../../sdks/typescript/react/src/test-support/preview-fixtures";
import type { Participant } from "../../../../../sdks/typescript/react/src/components/participant-grid/ParticipantGrid";
import type { SettingsDialogValue } from "../../../../../sdks/typescript/react/src/components/composite/SettingsDialog";
import type { ReconnectingOverlayProps } from "../../../../../sdks/typescript/react/src/components/reconnecting-overlay/ReconnectingOverlay";
import { createSnapshot } from "../../../../../sdks/typescript/react/src/test-support/preview-client";

import { PREVIEW_CAPABILITIES, type PreviewSearch } from "./preview-state";

export const SPACE_NAME = "Design review Space";
export const SPACE_DESCRIPTION = "Critiques, focused work, and product decisions.";
export const DISPLAY_NAME = "Hasan";
export const SPACE_LINK = "https://chalk.example/spaces/design-review";
export const DIAGNOSTIC_REFERENCE = "chalkdiag:v1:preview-reference";
export const PREVIEW_EPOCH = "2026-08-01T10:00:00.000Z";

export type GalleryParticipant = Participant;
type GalleryPendingMessage = SpaceSnapshot["chat"]["pendingSends"][number];

const PARTICIPANT_FIXTURES: readonly GalleryParticipant[] = [
  { id: "you", displayName: DISPLAY_NAME, isLocal: true, isMuted: false, isVideoEnabled: true, connectionQuality: 4 },
  { id: "nora", displayName: "Nora Williams", isSpeaking: true, isMuted: false, isVideoEnabled: true, connectionQuality: 4 },
  { id: "akash", displayName: "Akash Jain", isMuted: true, isVideoEnabled: false, isHandRaised: true, connectionQuality: 3 },
  { id: "sofia", displayName: "Sofia Chen", isMuted: false, isVideoEnabled: true, connectionQuality: 2 },
  { id: "malik", displayName: "Malik Brooks", isMuted: true, isVideoEnabled: true, connectionQuality: 4 },
  { id: "priya", displayName: "Priya Shah", isMuted: false, isVideoEnabled: true, connectionQuality: 4 },
  { id: "eli", displayName: "Eli Morgan", isMuted: true, isVideoEnabled: false, connectionQuality: 3 },
  { id: "june", displayName: "June Okafor", isMuted: false, isVideoEnabled: true, connectionQuality: 4 },
  { id: "tomas", displayName: "Tomás Rivera", isMuted: true, isVideoEnabled: true, connectionQuality: 1 },
  { id: "lena", displayName: "Lena Fischer", isMuted: false, isVideoEnabled: false, connectionQuality: 4 },
  { id: "kenji", displayName: "Kenji Sato", isMuted: true, isVideoEnabled: true, isHandRaised: true, connectionQuality: 4 },
  { id: "amara", displayName: "Amara Diallo", isMuted: false, isVideoEnabled: true, connectionQuality: 3 },
];

export const INITIAL_CHAT_MESSAGES: readonly ChalkChatMessage[] = [
  { messageId: "preview-message-1", clientMessageId: "preview-client-1", sequence: "1", participantId: "nora", displayName: "Nora Williams", text: "The new Space direction feels much calmer.", createdAt: "2026-08-01T10:12:00.000Z", attachments: [] },
  { messageId: "preview-message-2", clientMessageId: "preview-client-2", sequence: "2", participantId: "you", displayName: DISPLAY_NAME, text: "Agreed. Let’s keep the controls out of the stage.", createdAt: "2026-08-01T10:13:00.000Z", attachments: [] },
  { messageId: "preview-message-3", clientMessageId: "preview-client-3", sequence: "3", participantId: "sofia", displayName: "Sofia Chen", text: "I’ll share the revised agenda here after the Space.", createdAt: "2026-08-01T10:14:00.000Z", attachments: [] },
];

export const WAITING_PARTICIPANTS = [
  { id: "participant-priya", displayName: "Priya Shah", joinedAt: new Date("2026-08-01T10:14:00.000Z") },
  { id: "participant-eli", displayName: "Eli Morgan", joinedAt: new Date("2026-08-01T10:16:00.000Z") },
];

export const INITIAL_SETTINGS: SettingsDialogValue = {
  identity: { displayName: DISPLAY_NAME },
  join: { videoEnabled: true, audioEnabled: true },
  audio: { selectedInput: "preview-microphone", selectedOutput: "preview-speaker", outputVolume: 68, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
  video: { selectedInput: "preview-camera", quality: "auto" },
  appearance: { layout: "focus", theme: "dark", skin: "classic", palette: "warm-charcoal", texture: "paper", gradient: "default", showFilmstrip: true, reducedMotion: false, generatedAvatars: true, profileGradient: { mode: "auto" }, ambientBackground: false },
  experience: { captions: false, compactMode: false, showInviteToast: false, defaultOpenChat: false, defaultOpenParticipants: false, defaultOpenTranscription: false, autoOpenPictureInPicture: false, sounds: true },
};

export const TOAST_MESSAGES: Record<Exclude<PreviewSearch["toast"], "none">, string> = {
  info: "A new Participant joined this Space.",
  success: "The Space link is ready to share.",
  warning: "A Participant raised a hand.",
  error: "The Space connection is unstable.",
};

export const REACTIONS: readonly ChalkReactionEvent[] = [{ eventId: "preview-reaction-1", participantId: "nora", displayName: "Nora Williams", reaction: "🎉", occurredAt: "2026-08-01T10:15:00.000Z", expiresAt: "2026-08-01T10:16:00.000Z" }];

type LegacyPalette = "cosmic" | "midnight" | "slate" | "paper";
type LegacyTexture = "soft-grid" | "soft-dots";

export function productionPalette(palette: ThemePalette | LegacyPalette): ThemePalette {
  switch (palette) {
    case "cosmic":
      return "cosmic-chalk";
    case "midnight":
      return "oled-signal";
    case "slate":
      return "cool-graphite";
    case "paper":
      return "light";
    default:
      return palette;
  }
}

export function productionTexture(texture: ThemeTexture | LegacyTexture): ThemeTexture {
  switch (texture) {
    case "soft-grid":
      return "paper";
    case "soft-dots":
      return "slate";
    default:
      return texture;
  }
}

export function participantsForCount(count: PreviewSearch["participants"], search: PreviewSearch): GalleryParticipant[] {
  const microphoneEnabled = search.mic === "enabled" || search.mic === "requesting";
  const cameraEnabled = search.camera === "enabled" || search.camera === "requesting";
  const screenShare = !search.features.screenShare ? "none" : search.screenShare === "none" && search.stage === "share" ? "remote" : search.screenShare;
  const remoteSharer = PARTICIPANT_FIXTURES.find((participant) => !participant.isLocal)?.id;

  return PARTICIPANT_FIXTURES.slice(0, count).map((participant, index) => ({
    ...participant,
    isMuted: index === 0 ? !microphoneEnabled : participant.isMuted,
    isVideoEnabled: index === 0 ? cameraEnabled : participant.isVideoEnabled,
    isHandRaised: index === 0 ? search.features.handRaise && search.hand : participant.isHandRaised,
    isSpeaking: search.activeSpeaker === "none" ? participant.isSpeaking : participant.id === search.activeSpeaker,
    isActiveSpeaker: participant.id === search.activeSpeaker,
    isScreenSharing: screenShare === "local" ? Boolean(participant.isLocal) : screenShare === "remote" ? participant.id === remoteSharer : false,
  }));
}

export function chatPending(search: PreviewSearch): readonly GalleryPendingMessage[] {
  if (search.chat === "pending") return [{ clientMessageId: "preview-pending-1", text: "I’m sending the latest Space notes…", attachments: [], status: "sending", error: null }];
  if (search.chat === "failure") return [{ clientMessageId: "preview-failed-1", text: "Could not publish this update", attachments: [], status: "failed", error: { code: "client.internal_error", recoverable: true, message: "Chat is temporarily unavailable." } }];
  return [];
}

export type GalleryPanel = Exclude<SpacePanel, "settings">;

export function panelFor(search: PreviewSearch): GalleryPanel | null {
  switch (search.panel) {
    case "chat":
    case "participants":
      return search.panel;
    default:
      return null;
  }
}

export function statusOverlay(search: PreviewSearch, onRetry: () => void, onBack: () => void): (Omit<ReconnectingOverlayProps, "isVisible"> & { readonly isVisible: true }) | undefined {
  switch (search.state) {
    case "reconnecting":
      return { isVisible: true, status: "reconnecting", message: "The Space connection was interrupted. Reconnecting now…", onRetry, onLeft: onBack };
    case "retry":
      return { isVisible: true, status: "failed", message: "The Space connection needs another try.", supportCode: "space-retry-204", onRetry, onLeft: onBack };
    case "timeout":
      return { isVisible: true, status: "failed", message: "The Space took too long to reconnect.", supportCode: "space-timeout-408", onRetry, onLeft: onBack };
    default:
      return undefined;
  }
}

export interface PreviewSnapshotTrackSet {
  readonly microphone: MediaStreamTrack | null;
  readonly camera: MediaStreamTrack | null;
  readonly screen: MediaStreamTrack | null;
}

export interface PreviewSnapshotTracks {
  readonly local: PreviewSnapshotTrackSet;
  readonly remote: ReadonlyMap<string, PreviewSnapshotTrackSet>;
}

interface PreviewSnapshotOptions {
  readonly participants: readonly GalleryParticipant[];
  readonly search: PreviewSearch;
  readonly displayName: string;
  readonly episodeStartedAt: string;
  readonly tracks: PreviewSnapshotTracks;
}

/** Pure, deterministic projection of URL state into the client snapshot consumed by SpaceView. */
function createPreviewSnapshot({ participants, search, displayName, episodeStartedAt, tracks }: PreviewSnapshotOptions): SpaceSnapshot {
  const capabilities = capabilitiesFor(search);
  const role = roleName(search);
  const base = createSnapshot(capabilities);
  const roster: SpaceSnapshot["participants"]["roster"] = participants.map<SpaceSnapshot["participants"]["roster"][number]>((participant) => ({
    participantId: participant.id,
    displayName: participant.isLocal ? displayName : participant.displayName,
    role: participant.isLocal ? role : "collaborator",
    eligibleRoles: ["owner", "collaborator", "observer"],
    capabilities: participant.isLocal ? capabilities : [],
    handRaised: Boolean(participant.isHandRaised),
    presence: { state: "connected", speaking: Boolean(participant.isSpeaking), activeSpeaker: Boolean(participant.isActiveSpeaker) } satisfies SpaceSnapshot["participants"]["roster"][number]["presence"],
    media: {
      microphone: participant.isMuted ? "inactive" : "active",
      camera: participant.isVideoEnabled ? "active" : "inactive",
      screenShare: participant.isScreenSharing ? "active" : "inactive",
    },
  }));
  const admissionQueue =
    search.admissionQueue === "waiting"
      ? WAITING_PARTICIPANTS.map((participant, index) => ({
          requestId: participant.id,
          participantId: participant.id,
          displayName: participant.displayName,
          initialRole: "collaborator",
          eligibleRoles: ["owner", "collaborator", "observer"],
          expiresAt: new Date(Date.parse(PREVIEW_EPOCH) + (index + 1) * 60_000).toISOString(),
        }))
      : [];
  const remote: RemoteMedia[] = [];
  for (const participant of participants) {
    if (participant.isLocal) continue;
    const participantTracks = tracks.remote.get(participant.id);
    if (!participantTracks) continue;
    if (participantTracks.camera) remote.push({ participantId: participant.id, source: "camera", publicationId: `preview-${participant.id}-camera`, track: participantTracks.camera });
    if (participantTracks.screen) remote.push({ participantId: participant.id, source: "screen", publicationId: `preview-${participant.id}-screen`, track: participantTracks.screen });
    if (participantTracks.microphone) remote.push({ participantId: participant.id, source: "microphone", publicationId: `preview-${participant.id}-microphone`, track: participantTracks.microphone });
  }
  const microphone = localMedia("microphone", search.mic, tracks.local.microphone);
  const camera = localMedia("camera", search.camera, tracks.local.camera);
  const localScreenMode = !search.features.screenShare ? "none" : search.screenShare === "none" && search.stage === "share" ? "remote" : search.screenShare;
  const screen = localMedia("screen", localScreenMode === "local" ? "enabled" : "disabled", tracks.local.screen);
  const incomingRequests = incomingMediaRequests(search);
  const chatFailure: SpaceSnapshot["chat"]["lastError"] = search.chat === "failure" ? { code: "client.internal_error", recoverable: true, message: "Chat is temporarily unavailable in this Space." } : null;
  const status = search.state === "reconnecting" ? "reconnecting" : search.state === "leaving" ? "leaving" : search.state === "left" ? "left" : search.state === "failure" ? "failed" : "live";
  const episode = search.state === "left" ? null : { id: "preview-episode", startedAt: episodeStartedAt, deadline: null };

  return {
    ...base,
    connection: { ...base.connection, status, episode, lastError: status === "failed" ? { code: "connection.sync_start_failed", recoverable: true, message: "The Space connection failed before recovery completed." } : null },
    self: { ...base.self, participantId: "you", displayName, role, capabilities, handRaised: search.features.handRaise && search.hand, can: (capability: Capability) => capabilities.includes(capability) },
    participants: { roster, admissionQueue },
    media: { ...base.media, remote, incomingRequests, local: { ...base.media.local, microphone, camera, screen }, screenShare: screen },
    chat: {
      ...base.chat,
      status: search.chat === "loading" ? "loading" : search.chat === "failure" ? "failed" : search.chat === "ready" || search.chat === "pending" ? "ready" : "idle",
      messages: search.chat === "ready" || search.chat === "pending" ? INITIAL_CHAT_MESSAGES : [],
      pendingSends: chatPending(search),
      unreadCount: search.chat === "ready" || search.chat === "pending" ? 3 : 0,
      lastError: chatFailure,
    },
    reactions: { active: REACTIONS },
    whiteboard: { ...base.whiteboard, open: search.features.whiteboard && search.stage === "whiteboard" },
  };
}

export const buildPreviewSnapshot = createPreviewSnapshot;

function roleName(search: PreviewSearch): string {
  return search.role;
}

function capabilitiesFor(search: PreviewSearch): readonly Capability[] {
  return PREVIEW_CAPABILITIES[search.capability];
}

function localMedia(source: "microphone" | "camera" | "screen", state: PreviewSearch["mic"] | PreviewSearch["camera"] | "enabled" | "disabled", track: MediaStreamTrack | null): SpaceSnapshot["media"]["local"]["microphone"] {
  return { source, state, track: state === "enabled" || state === "requesting" ? track : null };
}

function incomingMediaRequests(search: PreviewSearch): SpaceSnapshot["media"]["incomingRequests"] {
  if (search.incomingMediaRequest === "none") return [];
  const kind = search.incomingMediaRequest === "unmute" ? "unmute" : "start_camera";
  return [{ requestId: "preview-incoming-media-1", kind, actorParticipantId: "nora", actorDisplayName: "Nora Williams", expiresAt: new Date(Date.now() + 90_000).toISOString() }];
}
