import type { ChalkIncomingMediaRequest, ChalkReaction, ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";

import type { NativeChatMessage, NativeReaction } from "../ui/native-types";

const ROOM_REACTIONS = new Set<ChalkReaction>(["👍", "❤️", "😂", "😮", "😢", "🎉"]);

export interface NativeRoomActionsProjection {
  readonly chatEnabled: boolean;
  readonly reactionEnabled: boolean;
  readonly messages: readonly NativeChatMessage[];
  readonly reactions: readonly NativeReaction[];
  readonly incomingRequest: ChalkIncomingMediaRequest | null;
}

export interface NativeRoomActionCommands {
  readonly retryConnection?: () => Promise<void>;
  readonly sendChatMessage: (text: string) => Promise<void>;
  readonly sendReaction: (reaction: string) => Promise<void>;
  readonly requestUnmute: (participantSessionId: string) => Promise<void>;
  readonly requestStartCamera: (participantSessionId: string) => Promise<void>;
  readonly muteParticipant: (participantSessionId: string) => Promise<void>;
  readonly stopParticipantCamera: (participantSessionId: string) => Promise<void>;
  readonly removeParticipant: (participantSessionId: string) => Promise<void>;
  readonly acceptMediaRequest: (requestId: string) => Promise<void>;
  readonly declineMediaRequest: (requestId: string) => void;
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

export function projectNativeRoomActions(snapshot: ChalkSessionSnapshot | null): NativeRoomActionsProjection {
  if (!snapshot) {
    return {
      chatEnabled: false,
      reactionEnabled: false,
      messages: [],
      reactions: [],
      incomingRequest: null,
    };
  }

  const negotiated = snapshot.roomActions.phase === "healthy";
  return {
    chatEnabled: negotiated && snapshot.roomActions.capabilities.includes("sendChat"),
    reactionEnabled: negotiated && snapshot.roomActions.capabilities.includes("sendReaction"),
    messages: snapshot.chat.messages.map((message) => ({
      id: message.messageId,
      sequence: message.sequence,
      senderId: message.participantSessionId,
      senderName: message.displayName,
      text: message.text,
      content: message.text,
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
      readBy: snapshot.chat.readReceipts
        .filter((receipt) => receipt.participantSessionId !== message.participantSessionId && !isLocalReceipt(snapshot, receipt.participantSessionId, receipt.participantSessionGeneration) && sequenceAtOrAfter(receipt.readThroughSequence, message.sequence))
        .map((receipt) => ({
          ...receipt,
          displayName: snapshot.participants.find((participant) => participant.participantSessionId === receipt.participantSessionId)?.displayName ?? "Participant",
        })),
      timestamp: Date.parse(message.createdAt),
    })),
    reactions: snapshot.reactions.map((reaction) => ({
      id: reaction.eventId,
      emoji: reaction.reaction,
      participantId: reaction.participantSessionId,
      participantName: reaction.displayName,
    })),
    incomingRequest: snapshot.incomingMediaRequests[0] ?? null,
  };
}

export function createNativeRoomActionCommands(store: ChalkSessionStore): NativeRoomActionCommands {
  return {
    retryConnection: () => store.join(),
    async sendChatMessage(text) {
      await store.sendChatMessage({ text });
    },
    async sendReaction(reaction) {
      if (!isRoomReaction(reaction)) throw new Error("Unsupported room reaction.");
      await store.sendReaction(reaction);
    },
    async requestUnmute(participantSessionId) {
      await store.requestUnmute(participantSessionId);
    },
    async requestStartCamera(participantSessionId) {
      await store.requestStartCamera(participantSessionId);
    },
    muteParticipant: (participantSessionId) => store.muteParticipant(participantSessionId),
    stopParticipantCamera: (participantSessionId) => store.stopParticipantCamera(participantSessionId),
    removeParticipant: (participantSessionId) => store.removeParticipant(participantSessionId),
    acceptMediaRequest: (requestId) => store.acceptMediaRequest(requestId),
    declineMediaRequest: (requestId) => store.declineMediaRequest(requestId),
  };
}

export function createNativeMediaRequestPrompt(request: ChalkIncomingMediaRequest, commands: NativeRoomActionCommands, reportFailure: (cause: unknown) => void): NativeMediaRequestPrompt {
  const actor = request.actorDisplayName ?? "A meeting moderator";
  const action = request.kind === "unmute" ? "unmute" : "start your camera";
  return {
    title: request.kind === "unmute" ? "Unmute request" : "Camera request",
    message: `${actor} is asking you to ${action}.`,
    buttons: [
      {
        text: "Not now",
        style: "cancel",
        onPress: () => commands.declineMediaRequest(request.requestId),
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

function isLocalReceipt(snapshot: ChalkSessionSnapshot, participantSessionId: string, participantSessionGeneration: number): boolean {
  return snapshot.subject?.participantSessionId === participantSessionId && snapshot.subject.participantGeneration === participantSessionGeneration;
}

function sequenceAtOrAfter(value: string, floor: string): boolean {
  const normalizedValue = value.replace(/^0+(?=\d)/, "");
  const normalizedFloor = floor.replace(/^0+(?=\d)/, "");
  return normalizedValue.length > normalizedFloor.length || (normalizedValue.length === normalizedFloor.length && normalizedValue >= normalizedFloor);
}
