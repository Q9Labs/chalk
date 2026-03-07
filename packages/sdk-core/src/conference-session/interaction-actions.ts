import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { ChatMessage, Participant, ReactionEmoji } from "../types.ts";
import type { WSClient } from "../ws-client.ts";

interface InteractionActionsDeps {
  getWsClient: () => WSClient | undefined;
  getRtkClient: () => RealtimeKitClient | undefined;
  getLocalParticipant: () => Participant | null;
  emitChatMessage: (message: ChatMessage) => void;
  emitParticipantUpdated: (participantId: string, participant: Participant) => void;
  emitHandRaised: (participantId: string) => void;
  emitHandLowered: (participantId: string) => void;
}

export const createConferenceSessionInteractionActions = (deps: InteractionActionsDeps) => {
  let pendingHandRaised: boolean | null = null;
  let pendingHandSyncCleanup: (() => void) | null = null;

  const clearPendingHandSync = (): void => {
    pendingHandSyncCleanup?.();
    pendingHandSyncCleanup = null;
  };

  const flushPendingHandSync = (): void => {
    const wsClient = deps.getWsClient();
    if (!wsClient || pendingHandRaised === null || wsClient.connectionState !== "connected") {
      return;
    }

    if (pendingHandRaised) {
      wsClient.raiseHand();
    } else {
      wsClient.lowerHand();
    }

    pendingHandRaised = null;
    clearPendingHandSync();
  };

  const syncHandState = (isRaised: boolean): void => {
    const wsClient = deps.getWsClient();
    if (!wsClient) {
      return;
    }

    if (wsClient.connectionState === "connected") {
      pendingHandRaised = null;
      clearPendingHandSync();
      if (isRaised) {
        wsClient.raiseHand();
      } else {
        wsClient.lowerHand();
      }
      return;
    }

    pendingHandRaised = isRaised;
    if (!pendingHandSyncCleanup) {
      pendingHandSyncCleanup = wsClient.on("connected", () => {
        flushPendingHandSync();
      });
    }
  };

  const sendMessage = (content: string): void => {
    if (!content.trim()) {
      return;
    }

    const trimmed = content.trim();
    const wsClient = deps.getWsClient();
    const rtkClient = deps.getRtkClient();

    if (wsClient) {
      wsClient.sendChatMessage(trimmed);
    } else if (rtkClient) {
      try {
        rtkClient.chat?.sendTextMessage(trimmed);
      } catch {
        // best effort
      }
    } else {
      const localParticipant = deps.getLocalParticipant();
      const localMessage: ChatMessage = {
        id: crypto.randomUUID(),
        senderId: localParticipant?.id ?? "local",
        senderName: localParticipant?.displayName ?? "You",
        content: trimmed,
        timestamp: new Date(),
      };
      deps.emitChatMessage(localMessage);
    }
  };

  const sendReaction = (emoji: ReactionEmoji): void => {
    const wsClient = deps.getWsClient();
    const rtkClient = deps.getRtkClient();

    if (wsClient) {
      wsClient.sendReaction(emoji);
      return;
    }

    if (!rtkClient) {
      return;
    }

    try {
      (
        rtkClient as unknown as {
          reactions?: { send: (value: string) => void };
        }
      ).reactions?.send(emoji);
    } catch {
      // optional API
    }
  };

  const raiseHand = (): void => {
    const localParticipant = deps.getLocalParticipant();
    if (!localParticipant) {
      return;
    }

    localParticipant.handRaised = true;
    syncHandState(true);
    deps.emitParticipantUpdated(localParticipant.id, localParticipant);
    deps.emitHandRaised(localParticipant.id);
  };

  const lowerHand = (): void => {
    const localParticipant = deps.getLocalParticipant();
    if (!localParticipant) {
      return;
    }

    localParticipant.handRaised = false;
    syncHandState(false);
    deps.emitParticipantUpdated(localParticipant.id, localParticipant);
    deps.emitHandLowered(localParticipant.id);
  };

  const muteParticipant = (participantId: string): void => {
    const localParticipant = deps.getLocalParticipant();
    if (localParticipant?.role !== "host") {
      return;
    }
    if (participantId === localParticipant.id) {
      return;
    }
    deps.getWsClient()?.muteParticipant(participantId);
  };

  const unmuteParticipant = (participantId: string): void => {
    const localParticipant = deps.getLocalParticipant();
    if (localParticipant?.role !== "host") {
      return;
    }
    if (participantId === localParticipant.id) {
      return;
    }
    deps.getWsClient()?.unmuteParticipant(participantId);
  };

  return {
    sendMessage,
    sendReaction,
    raiseHand,
    lowerHand,
    muteParticipant,
    unmuteParticipant,
  };
};
