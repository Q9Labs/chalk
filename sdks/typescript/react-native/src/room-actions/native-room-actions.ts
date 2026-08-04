import type { ChalkIncomingMediaRequest, ChalkReaction, ChalkSessionSnapshot, ChalkSessionStore } from "../client-compat";

import type { NativeChatMessage, NativeReaction } from "../ui/native-types";

const ROOM_REACTIONS = new Set<ChalkReaction>(["👍", "❤️", "😂", "😮", "😢", "🎉"]);

export interface NativeActionsProjection {
  readonly chatEnabled: boolean;
  readonly reactionEnabled: boolean;
  readonly messages: readonly NativeChatMessage[];
  readonly reactions: readonly NativeReaction[];
  readonly incomingRequest: ChalkIncomingMediaRequest | null;
}

export interface NativeActionCommands {
  readonly sendChatMessage: (text: string) => Promise<void>;
  readonly sendReaction: (reaction: string) => Promise<void>;
  readonly requestUnmute: (participantId: string) => Promise<void>;
  readonly requestStartCamera: (participantId: string) => Promise<void>;
  readonly muteParticipant: (participantId: string) => Promise<void>;
  readonly stopParticipantCamera: (participantId: string) => Promise<void>;
  readonly removeParticipant: (participantId: string) => Promise<void>;
  readonly acceptMediaRequest: (requestId: string) => Promise<void>;
  readonly declineMediaRequest: (requestId: string) => Promise<void>;
}

export interface NativeMediaRequestPrompt {
  readonly title: string;
  readonly message: string;
  readonly buttons: readonly {
    readonly text: string;
    readonly style?: "cancel" | "default";
    readonly onPress: () => void;
  }[];
}

export function projectNativeActions(snapshot: ChalkSessionSnapshot | null): NativeActionsProjection {
  if (!snapshot) {
    return {
      chatEnabled: false,
      reactionEnabled: false,
      messages: [],
      reactions: [],
      incomingRequest: null,
    };
  }

  const negotiated = snapshot.actions.phase === "healthy";
  return {
    chatEnabled: negotiated && snapshot.actions.capabilities.includes("sendChat"),
    reactionEnabled: negotiated && snapshot.actions.capabilities.includes("sendReaction"),
    messages: snapshot.chat.messages.map((message) => ({
      id: message.messageId,
      sequence: message.sequence,
      senderId: message.participantId,
      senderName: message.displayName,
      text: message.text,
      content: message.text,
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
      readBy: snapshot.chat.readReceipts
        .filter((receipt) => receipt.participantId !== message.participantId && !isLocalReceipt(snapshot, receipt.participantId, receipt.participantGeneration) && sequenceAtOrAfter(receipt.readThroughSequence, message.sequence))
        .map((receipt) => ({
          ...receipt,
          displayName: snapshot.participants.find((participant) => participant.participantId === receipt.participantId)?.displayName ?? "Participant",
        })),
      timestamp: Date.parse(message.createdAt),
    })),
    reactions: snapshot.reactions.map((reaction) => ({
      id: reaction.eventId,
      emoji: reaction.reaction,
      participantId: reaction.participantId,
      participantName: reaction.displayName,
    })),
    incomingRequest: snapshot.incomingMediaRequests[0] ?? null,
  };
}

export function createNativeActionCommands(store: ChalkSessionStore): NativeActionCommands {
  return {
    async sendChatMessage(text) {
      await store.sendChatMessage({ text });
    },
    async sendReaction(reaction) {
      if (!isRoomReaction(reaction)) throw new Error("Unsupported room reaction.");
      await store.sendReaction(reaction);
    },
    async requestUnmute(participantId) {
      await store.requestUnmute(participantId);
    },
    async requestStartCamera(participantId) {
      await store.requestStartCamera(participantId);
    },
    muteParticipant: (participantId) => store.muteParticipant(participantId),
    stopParticipantCamera: (participantId) => store.stopParticipantCamera(participantId),
    removeParticipant: (participantId) => store.removeParticipant(participantId),
    acceptMediaRequest: (requestId) => store.acceptMediaRequest(requestId),
    declineMediaRequest: (requestId) => store.declineMediaRequest(requestId),
  };
}

export function createNativeMediaRequestPrompt(request: ChalkIncomingMediaRequest, commands: NativeActionCommands, reportFailure: (cause: unknown) => void): NativeMediaRequestPrompt {
  const actor = request.actorDisplayName ?? "A meeting moderator";
  const action = request.kind === "unmute" ? "unmute" : "start your camera";
  return {
    title: request.kind === "unmute" ? "Unmute request" : "Camera request",
    message: `${actor} is asking you to ${action}.`,
    buttons: [
      {
        text: "Not now",
        style: "cancel",
        onPress: () => {
          void commands.declineMediaRequest(request.requestId).catch(reportFailure);
        },
      },
      {
        text: "Allow",
        style: "default",
        onPress: () => {
          void commands.acceptMediaRequest(request.requestId).catch(reportFailure);
        },
      },
    ],
  };
}

function isRoomReaction(value: string): value is ChalkReaction {
  return ROOM_REACTIONS.has(value as ChalkReaction);
}

function isLocalReceipt(snapshot: ChalkSessionSnapshot, participantId: string, participantGeneration: number): boolean {
  return snapshot.subject?.participantId === participantId && snapshot.subject.participantGeneration === participantGeneration;
}

function sequenceAtOrAfter(value: string, floor: string): boolean {
  const normalizedValue = value.replace(/^0+(?=\d)/, "");
  const normalizedFloor = floor.replace(/^0+(?=\d)/, "");
  return normalizedValue.length > normalizedFloor.length || (normalizedValue.length === normalizedFloor.length && normalizedValue >= normalizedFloor);
}
