/**
 * useInteractions - Reactions and hand raise for React Native
 * Uses API WebSocket for real-time interactions
 */

import type { Reaction, ReactionEmoji } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChalk } from "../ChalkProvider";
import { logger } from "../logger";
import { useParticipants } from "./useParticipants";

export interface ActiveReaction {
  id: string;
  participantId: string;
  participantName?: string;
  emoji: ReactionEmoji;
  timestamp: number;
}

export interface UseInteractionsReturn {
  /** Whether local user has hand raised */
  isHandRaised: boolean;
  /** Participant IDs with raised hands */
  raisedHands: readonly string[];
  /** Count of raised hands */
  raisedHandCount: number;
  /** Active floating reactions */
  activeReactions: readonly ActiveReaction[];
  /** Raise hand */
  raiseHand: () => void;
  /** Lower hand */
  lowerHand: () => void;
  /** Toggle hand raise state */
  toggleHand: () => void;
  /** Send a floating reaction */
  sendReaction: (emoji: ReactionEmoji) => void;
}

/**
 * Hook for interactions (reactions and hand raise)
 */
export function useInteractions(): UseInteractionsReturn {
  const { wsClient, wsConnectionState, wsRoomId, wsParticipantId } = useChalk();
  const { localParticipant } = useParticipants();
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState<string[]>([]);
  const [activeReactions, setActiveReactions] = useState<ActiveReaction[]>([]);
  const reactionTimeouts = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const localId = wsParticipantId ?? localParticipant?.id ?? null;
  const localName = localParticipant?.displayName ?? "You";

  const clearReactions = useCallback(() => {
    for (const timeout of reactionTimeouts.current.values()) {
      clearTimeout(timeout);
    }
    reactionTimeouts.current.clear();
    setActiveReactions([]);
  }, []);

  const addReaction = useCallback(
    (reaction: Reaction) => {
      const reactionId = `${reaction.participantId}-${Date.now()}-${Math.random()}`;
      const active: ActiveReaction = {
        id: reactionId,
        participantId: reaction.participantId,
        participantName: reaction.participantName,
        emoji: reaction.emoji,
        timestamp: reaction.timestamp instanceof Date ? reaction.timestamp.getTime() : Date.now(),
      };

      setActiveReactions((prev) => [...prev, active]);
      const timeout = setTimeout(() => {
        setActiveReactions((prev) => prev.filter((r) => r.id !== reactionId));
        reactionTimeouts.current.delete(reactionId);
      }, 3000);
      reactionTimeouts.current.set(reactionId, timeout);
    },
    [setActiveReactions],
  );

  const syncRaisedHands = useCallback(
    (participantIds: string[]) => {
      setRaisedHands(participantIds);
      if (localId) {
        setIsHandRaised(participantIds.includes(localId));
      } else {
        setIsHandRaised(false);
      }
    },
    [localId],
  );

  useEffect(() => {
    if (!wsClient) {
      return;
    }

    const unsubscribeReaction = wsClient.on("reaction", (reaction) => {
      addReaction(reaction);
    });

    const unsubscribeHandRaised = wsClient.on("hand.raised", ({ participantId }) => {
      setRaisedHands((prev) => {
        if (prev.includes(participantId)) return prev;
        return [...prev, participantId];
      });
      if (participantId === localId) {
        setIsHandRaised(true);
      }
    });

    const unsubscribeHandLowered = wsClient.on("hand.lowered", ({ participantId }) => {
      setRaisedHands((prev) => prev.filter((id) => id !== participantId));
      if (participantId === localId) {
        setIsHandRaised(false);
      }
    });

    const unsubscribeSnapshot = wsClient.on("room.snapshot", (snapshot) => {
      const raised = snapshot.participants.filter((p) => p.handRaised).map((p) => p.id);
      syncRaisedHands(raised);
    });

    const unsubscribeSync = wsClient.on("room.sync", (snapshot) => {
      const raised = snapshot.participants.filter((p) => p.handRaised).map((p) => p.id);
      syncRaisedHands(raised);
    });

    const unsubscribeParticipantUpdated = wsClient.on("participant.updated", ({ participantId, changes }) => {
      if (typeof changes.handRaised !== "boolean") return;
      setRaisedHands((prev) => {
        if (changes.handRaised) {
          return prev.includes(participantId) ? prev : [...prev, participantId];
        }
        return prev.filter((id) => id !== participantId);
      });
      if (participantId === localId) {
        setIsHandRaised(changes.handRaised);
      }
    });

    const unsubscribeParticipantLeft = wsClient.on("participant.left", ({ participantId }) => {
      setRaisedHands((prev) => prev.filter((id) => id !== participantId));
    });

    const unsubscribeDisconnected = wsClient.on("disconnected", () => {
      setIsHandRaised(false);
      setRaisedHands([]);
      clearReactions();
    });

    return () => {
      unsubscribeReaction();
      unsubscribeHandRaised();
      unsubscribeHandLowered();
      unsubscribeSnapshot();
      unsubscribeSync();
      unsubscribeParticipantUpdated();
      unsubscribeParticipantLeft();
      unsubscribeDisconnected();
    };
  }, [wsClient, localId, addReaction, syncRaisedHands, clearReactions]);

  useEffect(() => {
    setIsHandRaised(false);
    setRaisedHands([]);
    clearReactions();
  }, [wsRoomId, clearReactions]);

  useEffect(() => {
    return () => {
      clearReactions();
    };
  }, [clearReactions]);

  const raiseHand = useCallback(() => {
    if (wsClient && wsConnectionState === "connected") {
      wsClient.raiseHand();
    } else {
      logger.info({
        event: "hand.raise.skipped",
        roomId: wsRoomId,
        reason: wsClient ? "ws_not_connected" : "ws_client_unavailable",
      });
    }

    if (localId) {
      setIsHandRaised(true);
      setRaisedHands((prev) => (prev.includes(localId) ? prev : [...prev, localId]));
    }
  }, [wsClient, wsConnectionState, wsRoomId, localId]);

  const lowerHand = useCallback(() => {
    if (wsClient && wsConnectionState === "connected") {
      wsClient.lowerHand();
    } else {
      logger.info({
        event: "hand.lower.skipped",
        roomId: wsRoomId,
        reason: wsClient ? "ws_not_connected" : "ws_client_unavailable",
      });
    }

    if (localId) {
      setIsHandRaised(false);
      setRaisedHands((prev) => prev.filter((id) => id !== localId));
    }
  }, [wsClient, wsConnectionState, wsRoomId, localId]);

  const toggleHand = useCallback(() => {
    if (isHandRaised) {
      lowerHand();
    } else {
      raiseHand();
    }
  }, [isHandRaised, raiseHand, lowerHand]);

  const sendReaction = useCallback(
    (emoji: ReactionEmoji) => {
      if (wsClient && wsConnectionState === "connected") {
        wsClient.sendReaction(emoji);
        return;
      }

      logger.info({
        event: "reaction.send.skipped",
        roomId: wsRoomId,
        reason: wsClient ? "ws_not_connected" : "ws_client_unavailable",
      });

      if (!localId) {
        return;
      }

      addReaction({
        participantId: localId,
        participantName: localName,
        emoji,
        timestamp: new Date(),
      });
    },
    [wsClient, wsConnectionState, wsRoomId, localId, localName, addReaction],
  );

  return useMemo(
    (): UseInteractionsReturn => ({
      isHandRaised,
      raisedHands,
      raisedHandCount: raisedHands.length,
      activeReactions,
      raiseHand,
      lowerHand,
      toggleHand,
      sendReaction,
    }),
    [isHandRaised, raisedHands, activeReactions, raiseHand, lowerHand, toggleHand, sendReaction],
  );
}

/**
 * Convenience hook for just hand raise functionality
 */
export function useHandRaise() {
  const { isHandRaised, raisedHands, raisedHandCount, raiseHand, lowerHand, toggleHand } = useInteractions();

  return {
    isHandRaised,
    raisedHands,
    raisedHandCount,
    raiseHand,
    lowerHand,
    toggleHand,
  };
}
