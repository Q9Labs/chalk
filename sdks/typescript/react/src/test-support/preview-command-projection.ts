import type { ActiveReaction, ChatMessage, ChatSendInput, Reaction, SpaceSnapshot } from "@q9labsai/chalk-client";
import { applyRosterCommand } from "./preview-roster-commands";
import type { PreviewClientCommand } from "./preview-client";

export function applyPreviewCommand(snapshot: SpaceSnapshot, command: PreviewClientCommand): SpaceSnapshot {
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
    case "reactToMessage": {
      const participantId = snapshot.self.participantId;
      if (!participantId) return snapshot;
      const messages = snapshot.chat.messages.map((message) => {
        if (message.messageId !== command.input.messageId) return message;
        const reactions = message.reactions ?? [];
        const existing = reactions.find((reaction) => reaction.emoji === command.input.emoji);
        const ids = existing?.participantIds ?? [];
        if (ids.includes(participantId) === command.input.on) return message;
        const participantIds = command.input.on ? [...ids, participantId] : ids.filter((id) => id !== participantId);
        const next = reactions.filter((reaction) => reaction.emoji !== command.input.emoji);
        if (participantIds.length) next.push({ emoji: command.input.emoji, count: participantIds.length, participantIds });
        return { ...message, reactions: next, reactionRevision: String(BigInt(message.reactionRevision ?? "0") + 1n) };
      });
      return { ...snapshot, chat: { ...snapshot.chat, messages } };
    }
    case "setScreenShareEnabled":
      return updateScreenShare(snapshot, command.enabled);
    case "startRecording":
      return { ...snapshot, recording: { current: { recordingId: command.recordingId, status: "recording", failureCode: null } } };
    case "stopRecording":
      return snapshot.recording.current ? { ...snapshot, recording: { current: { ...snapshot.recording.current, status: "stopped" } } } : snapshot;
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
    case "raiseHand":
    case "lowerHand":
      return { ...snapshot, self: { ...snapshot.self, handRaised: command.type === "raiseHand" } };
    case "renameSelf":
      return { ...snapshot, self: { ...snapshot.self, displayName: command.displayName } };
    case "sendReaction":
      return { ...snapshot, reactions: { active: [...snapshot.reactions.active, createPreviewReaction(snapshot, command.reaction)] } };
    case "sendChat":
      return addPendingChat(snapshot, command.input);
    case "markChatRead":
      return { ...snapshot, chat: { ...snapshot.chat, unreadCount: 0 } };
    default:
      return applyRosterCommand(snapshot, command);
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

function acceptIncomingRequest(snapshot: SpaceSnapshot, requestId: string): SpaceSnapshot {
  const request = snapshot.media.incomingRequests.find((candidate) => candidate.requestId === requestId);
  if (!request) return snapshot;
  const source = request.kind === "unmute" ? "microphone" : "camera";
  return updateLocalMedia(removeIncomingRequest(snapshot, requestId), source, true);
}

function removeIncomingRequest(snapshot: SpaceSnapshot, requestId: string): SpaceSnapshot {
  return { ...snapshot, media: { ...snapshot.media, incomingRequests: snapshot.media.incomingRequests.filter((request) => request.requestId !== requestId) } };
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

export function createPreviewChatMessage(snapshot: SpaceSnapshot, input: ChatSendInput): ChatMessage {
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

export function createPreviewReaction(snapshot: SpaceSnapshot, reaction: Reaction): ActiveReaction {
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
