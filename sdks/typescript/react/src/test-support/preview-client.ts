import type { ActiveReaction, Capability, ChatAttachment, ChatMessage, ChatSendInput, ChatUploadFile, ClientEventHandler, ClientEventName, IncomingMediaRequest, MediaRequestKind, Reaction, SpaceClient, SpaceSnapshot } from "@q9labsai/chalk-client";

import { createPreviewMediaDevices } from "./preview-devices";

export { PREVIEW_DEVICE_FIXTURES } from "./preview-devices";

export type PreviewClientCommand =
  | { readonly type: "join" }
  | { readonly type: "leave" }
  | { readonly type: "endEpisode" }
  | { readonly type: "extendEpisode"; readonly minutes: number }
  | { readonly type: "setMicrophoneEnabled"; readonly enabled: boolean }
  | { readonly type: "setCameraEnabled"; readonly enabled: boolean }
  | { readonly type: "setScreenShareEnabled"; readonly enabled: boolean }
  | { readonly type: "selectMicrophone"; readonly deviceId: string }
  | { readonly type: "selectCamera"; readonly deviceId: string }
  | { readonly type: "selectSpeaker"; readonly deviceId: string }
  | { readonly type: "acceptRequest"; readonly requestId: string }
  | { readonly type: "declineRequest"; readonly requestId: string }
  | { readonly type: "assignRole"; readonly participantId: string; readonly roleName: string }
  | { readonly type: "mute"; readonly participantId: string }
  | { readonly type: "stopVideo"; readonly participantId: string }
  | { readonly type: "stopScreenShare"; readonly participantId: string }
  | { readonly type: "requestMedia"; readonly participantId: string; readonly kind: MediaRequestKind; readonly requestId: string }
  | { readonly type: "remove"; readonly participantId: string }
  | { readonly type: "admit"; readonly requestId: string }
  | { readonly type: "deny"; readonly requestId: string }
  | { readonly type: "raiseHand" }
  | { readonly type: "lowerHand" }
  | { readonly type: "renameSelf"; readonly displayName: string }
  | { readonly type: "sendReaction"; readonly reaction: Reaction }
  | { readonly type: "sendChat"; readonly input: ChatSendInput }
  | { readonly type: "markChatRead"; readonly messageId: string };

export type PreviewClientCommandUpdater = (snapshot: SpaceSnapshot, command: PreviewClientCommand) => SpaceSnapshot;
export type PreviewClientCommandObserver = (command: PreviewClientCommand, snapshot: SpaceSnapshot) => void;
export type PreviewClientOptions = {
  /** Replaces the default local command projection when a gallery needs custom URL state. */
  readonly updateCommand?: PreviewClientCommandUpdater;
  /** Observes commands after the local snapshot has been published. */
  readonly onCommand?: PreviewClientCommandObserver;
};

export type PreviewClient = SpaceClient & {
  readonly setSnapshot: (snapshot: SpaceSnapshot) => void;
  readonly updateSnapshot: (update: (snapshot: SpaceSnapshot) => SpaceSnapshot) => void;
  readonly dispatch: (command: PreviewClientCommand) => Promise<void>;
};

/**
 * Local stand-in client for URL-addressable previews and fixtures. Commands
 * project into the local snapshot and never open a network connection.
 */
export function createPreviewClient(initialSnapshot = createSnapshot(), options: PreviewClientOptions = {}): PreviewClient {
  let snapshot = initialSnapshot;
  let requestSequence = 0;
  let attachmentSequence = 0;
  const listeners = new Set<() => void>();

  const setSnapshot = (nextSnapshot: SpaceSnapshot): void => {
    snapshot = nextSnapshot;
    for (const listener of listeners) listener();
  };
  const updateSnapshot = (update: (current: SpaceSnapshot) => SpaceSnapshot): void => setSnapshot(update(snapshot));
  const dispatch = async (command: PreviewClientCommand): Promise<void> => {
    const nextSnapshot = (options.updateCommand ?? applyPreviewCommand)(snapshot, command);
    setSnapshot(nextSnapshot);
    options.onCommand?.(command, nextSnapshot);
  };

  const client = {
    media: {
      setMicrophoneEnabled: (enabled: boolean) => dispatch({ type: "setMicrophoneEnabled", enabled }),
      setCameraEnabled: (enabled: boolean) => dispatch({ type: "setCameraEnabled", enabled }),
      setScreenShareEnabled: (enabled: boolean) => dispatch({ type: "setScreenShareEnabled", enabled }),
      selectMicrophone: (deviceId: string) => dispatch({ type: "selectMicrophone", deviceId }),
      selectCamera: (deviceId: string) => dispatch({ type: "selectCamera", deviceId }),
      selectSpeaker: (deviceId: string) => dispatch({ type: "selectSpeaker", deviceId }),
      acceptRequest: (requestId: string) => dispatch({ type: "acceptRequest", requestId }),
      declineRequest: (requestId: string) => dispatch({ type: "declineRequest", requestId }),
    },
    chat: {
      files: {
        upload: async (file: ChatUploadFile) => {
          const fileName = "name" in file ? file.name : file.fileName;
          const byteLength = "size" in file ? file.size : file.bytes.byteLength;
          const attachment: ChatAttachment = { attachmentId: `preview-attachment-${++attachmentSequence}`, fileName, mimeType: "text/plain", byteLength };
          return attachment;
        },
        url: (attachment: ChatAttachment) => `preview://attachment/${attachment.attachmentId}`,
      },
      send: async (input: ChatSendInput) => {
        const message = createPreviewChatMessage(snapshot, input);
        await dispatch({ type: "sendChat", input });
        return message;
      },
      loadOlder: async () => ({ status: "loaded", count: 0, hasOlder: snapshot.chat.pagination.hasOlder }),
      markRead: async (messageId: string) => {
        await dispatch({ type: "markChatRead", messageId });
        return null;
      },
    },
    participants: {
      assignRole: (participantId: string, roleName: string) => dispatch({ type: "assignRole", participantId, roleName }),
      mute: (participantId: string) => dispatch({ type: "mute", participantId }),
      stopVideo: (participantId: string) => dispatch({ type: "stopVideo", participantId }),
      stopScreenShare: (participantId: string) => dispatch({ type: "stopScreenShare", participantId }),
      requestMedia: async (participantId: string, kind: MediaRequestKind) => {
        const requestId = `preview-media-request-${++requestSequence}`;
        await dispatch({ type: "requestMedia", participantId, kind, requestId });
        return { status: "delivered", requestId };
      },
      remove: (participantId: string) => dispatch({ type: "remove", participantId }),
      admit: (requestId: string) => dispatch({ type: "admit", requestId }),
      deny: (requestId: string) => dispatch({ type: "deny", requestId }),
      raiseHand: () => dispatch({ type: "raiseHand" }),
      lowerHand: () => dispatch({ type: "lowerHand" }),
      renameSelf: (displayName: string) => dispatch({ type: "renameSelf", displayName }),
    },
    reactions: {
      send: async (reaction: Reaction) => {
        const active = createPreviewReaction(snapshot, reaction);
        await dispatch({ type: "sendReaction", reaction });
        return active;
      },
    },
    whiteboard: { transport: () => null },
    join: () => dispatch({ type: "join" }),
    leave: () => dispatch({ type: "leave" }),
    dispose: () => listeners.clear(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    endEpisode: () => dispatch({ type: "endEpisode" }),
    extendEpisode: (minutes: number) => dispatch({ type: "extendEpisode", minutes }),
    on:
      <TEvent extends ClientEventName>(_event: TEvent, _handler: ClientEventHandler<TEvent>) =>
      () =>
        undefined,
  } satisfies SpaceClient;

  return Object.assign(client, { setSnapshot, updateSnapshot, dispatch });
}

export function createSnapshot(capabilities: readonly Capability[] = ["sendChat"]): SpaceSnapshot {
  return {
    connection: { status: "idle", episode: null, lastError: null },
    self: { participantId: null, displayName: null, role: null, capabilities, handRaised: false, can: (capability) => capabilities.includes(capability) },
    participants: { roster: [], admissionQueue: [] },
    media: {
      devices: {
        ...createPreviewMediaDevices(),
      },
      selection: { microphone: "preview-microphone", camera: "preview-camera", speaker: "preview-speaker" },
      local: { microphone: { source: "microphone", state: "disabled", track: null }, camera: { source: "camera", state: "disabled", track: null }, screen: { source: "screen", state: "disabled", track: null } },
      remote: [],
      screenShare: { source: "screen", state: "disabled", track: null },
      incomingRequests: [],
    },
    chat: { status: "idle", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false }, lastError: null },
    reactions: { active: [] },
    whiteboard: { open: false, engine: { status: "unsubscribed", sceneId: null, revision: null, presenting: false, error: null } },
  };
}

function applyPreviewCommand(snapshot: SpaceSnapshot, command: PreviewClientCommand): SpaceSnapshot {
  switch (command.type) {
    case "join":
      return { ...snapshot, connection: { ...snapshot.connection, status: "live" } };
    case "leave":
      return { ...snapshot, connection: { ...snapshot.connection, status: "leaving" } };
    case "endEpisode":
      return { ...snapshot, connection: { ...snapshot.connection, status: "left", episode: null } };
    case "extendEpisode":
      if (!snapshot.connection.episode) return snapshot;
      return {
        ...snapshot,
        connection: {
          ...snapshot.connection,
          episode: {
            ...snapshot.connection.episode,
            deadline: addPreviewMinutes(snapshot.connection.episode.deadline ?? "2026-08-01T10:00:00.000Z", command.minutes),
          },
        },
      };
    case "setMicrophoneEnabled":
      return updateLocalMedia(snapshot, "microphone", command.enabled);
    case "setCameraEnabled":
      return updateLocalMedia(snapshot, "camera", command.enabled);
    case "setScreenShareEnabled":
      return updateScreenShare(snapshot, command.enabled);
    case "selectMicrophone":
      return { ...snapshot, media: { ...snapshot.media, selection: { ...snapshot.media.selection, microphone: command.deviceId } } };
    case "selectCamera":
      return { ...snapshot, media: { ...snapshot.media, selection: { ...snapshot.media.selection, camera: command.deviceId } } };
    case "selectSpeaker":
      return { ...snapshot, media: { ...snapshot.media, selection: { ...snapshot.media.selection, speaker: command.deviceId } } };
    case "acceptRequest":
      return acceptIncomingRequest(snapshot, command.requestId);
    case "declineRequest":
      return removeIncomingRequest(snapshot, command.requestId);
    case "assignRole":
      return {
        ...snapshot,
        participants: {
          ...snapshot.participants,
          roster: snapshot.participants.roster.map((participant) => (participant.participantId === command.participantId ? { ...participant, role: command.roleName } : participant)),
        },
      };
    case "mute":
      return updateParticipantMedia(snapshot, command.participantId, "microphone", "inactive");
    case "stopVideo":
      return updateParticipantMedia(snapshot, command.participantId, "camera", "inactive");
    case "stopScreenShare":
      return updateParticipantMedia(snapshot, command.participantId, "screenShare", "inactive");
    case "requestMedia":
      return addIncomingRequest(snapshot, command);
    case "remove":
      return { ...snapshot, participants: { ...snapshot.participants, roster: snapshot.participants.roster.filter((participant) => participant.participantId !== command.participantId) } };
    case "admit":
    case "deny":
      return { ...snapshot, participants: { ...snapshot.participants, admissionQueue: snapshot.participants.admissionQueue.filter((request) => request.requestId !== command.requestId) } };
    case "raiseHand":
      return { ...snapshot, self: { ...snapshot.self, handRaised: true } };
    case "lowerHand":
      return { ...snapshot, self: { ...snapshot.self, handRaised: false } };
    case "renameSelf":
      return { ...snapshot, self: { ...snapshot.self, displayName: command.displayName } };
    case "sendReaction":
      return { ...snapshot, reactions: { active: [...snapshot.reactions.active, createPreviewReaction(snapshot, command.reaction)] } };
    case "sendChat":
      return addPendingChat(snapshot, command.input);
    case "markChatRead":
      return { ...snapshot, chat: { ...snapshot.chat, unreadCount: 0 } };
  }
}

function updateLocalMedia(snapshot: SpaceSnapshot, source: "microphone" | "camera", enabled: boolean): SpaceSnapshot {
  return { ...snapshot, media: { ...snapshot.media, local: { ...snapshot.media.local, [source]: { ...snapshot.media.local[source], state: enabled ? "enabled" : "disabled" } } } };
}

function updateScreenShare(snapshot: SpaceSnapshot, enabled: boolean): SpaceSnapshot {
  const state: "enabled" | "disabled" = enabled ? "enabled" : "disabled";
  const screen = { ...snapshot.media.local.screen, state };
  return { ...snapshot, media: { ...snapshot.media, local: { ...snapshot.media.local, screen }, screenShare: screen } };
}

function updateParticipantMedia(snapshot: SpaceSnapshot, participantId: string, source: "microphone" | "camera" | "screenShare", state: "inactive"): SpaceSnapshot {
  return {
    ...snapshot,
    participants: {
      ...snapshot.participants,
      roster: snapshot.participants.roster.map((participant) => (participant.participantId === participantId ? { ...participant, media: { ...participant.media, [source]: state } } : participant)),
    },
  };
}

function acceptIncomingRequest(snapshot: SpaceSnapshot, requestId: string): SpaceSnapshot {
  const request = snapshot.media.incomingRequests.find((candidate) => candidate.requestId === requestId);
  if (!request) return snapshot;
  const source = request.kind === "unmute" ? "microphone" : "camera";
  return updateLocalMedia(removeIncomingRequest(snapshot, requestId), source, true);
}

function removeIncomingRequest(snapshot: SpaceSnapshot, requestId: string): SpaceSnapshot {
  return { ...snapshot, media: { ...snapshot.media, incomingRequests: snapshot.media.incomingRequests.filter((request) => request.requestId !== requestId) } };
}

function addIncomingRequest(snapshot: SpaceSnapshot, command: Extract<PreviewClientCommand, { readonly type: "requestMedia" }>): SpaceSnapshot {
  const participant = snapshot.participants.roster.find((candidate) => candidate.participantId === command.participantId);
  const request: IncomingMediaRequest = {
    requestId: command.requestId,
    kind: command.kind === "microphone" ? "unmute" : "start_camera",
    actorParticipantId: command.participantId,
    actorDisplayName: participant?.displayName ?? null,
    expiresAt: "2026-08-01T10:20:00.000Z",
  };
  return { ...snapshot, media: { ...snapshot.media, incomingRequests: [...snapshot.media.incomingRequests, request] } };
}

function addPendingChat(snapshot: SpaceSnapshot, input: ChatSendInput): SpaceSnapshot {
  const clientMessageId = `preview-message-${snapshot.chat.pendingSends.length + snapshot.chat.messages.length + 1}`;
  return {
    ...snapshot,
    chat: {
      ...snapshot.chat,
      pendingSends: [...snapshot.chat.pendingSends, { clientMessageId, text: input.text, attachments: input.attachments ?? [], status: "sending", error: null }],
      status: "ready",
    },
  };
}

function createPreviewChatMessage(snapshot: SpaceSnapshot, input: ChatSendInput): ChatMessage {
  const sequence = String(snapshot.chat.messages.length + 1);
  return {
    messageId: `preview-message-${sequence}`,
    clientMessageId: `preview-message-${snapshot.chat.pendingSends.length + snapshot.chat.messages.length + 1}`,
    sequence,
    participantId: snapshot.self.participantId ?? "preview-self",
    displayName: snapshot.self.displayName ?? "Preview Participant",
    text: input.text,
    createdAt: "2026-08-01T10:00:00.000Z",
    attachments: input.attachments ?? [],
  };
}

function createPreviewReaction(snapshot: SpaceSnapshot, reaction: Reaction): ActiveReaction {
  const eventId = `preview-reaction-${snapshot.reactions.active.length + 1}`;
  return {
    eventId,
    participantId: snapshot.self.participantId ?? "preview-self",
    displayName: snapshot.self.displayName ?? "Preview Participant",
    reaction,
    occurredAt: "2026-08-01T10:00:00.000Z",
    expiresAt: "2026-08-01T10:01:00.000Z",
  };
}

function addPreviewMinutes(value: string, minutes: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp + minutes * 60_000).toISOString();
}
