import type RealtimeKitClient from "@cloudflare/realtimekit";
import type { ChatMessage, Participant, ReactionEmoji } from "../types.ts";
import { wideEvents } from "../wide-events/index.ts";
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
    const ctx = wideEvents.start(isRaised ? "hand.raise" : "hand.lower");
    ctx.merge({
      direction: "queued",
      wsConnectionState: wsClient.connectionState,
    });
    ctx.complete("success");
    if (!pendingHandSyncCleanup) {
      pendingHandSyncCleanup = wsClient.on("connected", () => {
        flushPendingHandSync();
      });
    }
  };

  const sendMessage = (content: string, attachmentIds?: string[]): void => {
    if (!content.trim()) {
      if (!attachmentIds || attachmentIds.length === 0) {
        return;
      }
    }

    const trimmed = content.trim();
    const normalizedAttachmentIds = attachmentIds?.filter(Boolean) ?? [];

    if (!trimmed && normalizedAttachmentIds.length === 0) {
      return;
    }

    const wsClient = deps.getWsClient();
    const rtkClient = deps.getRtkClient();
    const wsConnectionState = wsClient?.connectionState ?? "missing";

    if (wsClient?.connectionState === "connected") {
      wsClient.sendChatMessage(trimmed, normalizedAttachmentIds);
      return;
    }

    const ctx = wideEvents.start("chat.send");
    ctx.merge({
      contentLength: trimmed.length,
      attachmentCount: normalizedAttachmentIds.length,
      wsConnectionState,
    });

    if (rtkClient) {
      ctx.set("transport", wsClient ? "rtk-fallback" : "rtk");
      try {
        rtkClient.chat?.sendTextMessage(trimmed);
        ctx.complete("success");
      } catch {
        ctx.complete("error", {
          code: "RTK_CHAT_SEND_FAILED",
          message: "Failed to send chat message through RealtimeKit fallback",
        });
        // best effort
      }
      return;
    }

    ctx.set("transport", "local-echo");
    const localParticipant = deps.getLocalParticipant();
    const localMessage: ChatMessage = {
      id: crypto.randomUUID(),
      senderId: localParticipant?.id ?? "local",
      senderName: localParticipant?.displayName ?? "You",
      content: trimmed,
      timestamp: new Date(),
      attachments: [],
      readBy: [],
    };
    deps.emitChatMessage(localMessage);
    ctx.complete("error", {
      code: "CHAT_LOCAL_ONLY",
      message: "No realtime transport available; message echoed locally only",
    });
  };

  const markChatRead = (readThroughMessageId: string): void => {
    if (!readThroughMessageId) {
      return;
    }
    deps.getWsClient()?.sendChatRead(readThroughMessageId);
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
    markChatRead,
  };
};
