/**
 * useInteractions - Reactions and hand raise for React Native
 * Note: Full functionality requires WebSocket integration (not yet implemented)
 */

import type { ReactionEmoji } from "@q9labs/chalk-core";
import { useCallback, useMemo, useState } from "react";
import { useChalk } from "../ChalkProvider";

export interface ActiveReaction {
	id: string;
	participantId: string;
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
 * Currently operates in demo mode - WebSocket integration pending
 */
export function useInteractions(): UseInteractionsReturn {
	const { roomInfo } = useChalk();

	const [isHandRaised, setIsHandRaised] = useState(false);
	const [raisedHands, setRaisedHands] = useState<string[]>([]);
	const [activeReactions, setActiveReactions] = useState<ActiveReaction[]>([]);

	const raiseHand = useCallback(() => {
		// TODO: Send via WebSocket when integrated
		setIsHandRaised(true);
		if (roomInfo) {
			setRaisedHands((prev) => {
				if (prev.includes(roomInfo.participantId)) return prev;
				return [...prev, roomInfo.participantId];
			});
		}
	}, [roomInfo]);

	const lowerHand = useCallback(() => {
		// TODO: Send via WebSocket when integrated
		setIsHandRaised(false);
		if (roomInfo) {
			setRaisedHands((prev) =>
				prev.filter((id) => id !== roomInfo.participantId),
			);
		}
	}, [roomInfo]);

	const toggleHand = useCallback(() => {
		if (isHandRaised) {
			lowerHand();
		} else {
			raiseHand();
		}
	}, [isHandRaised, raiseHand, lowerHand]);

	const sendReaction = useCallback(
		(emoji: ReactionEmoji) => {
			// TODO: Send via WebSocket when integrated
			const participantId = roomInfo?.participantId ?? "local";
			const reaction: ActiveReaction = {
				id: `${participantId}-${Date.now()}-${Math.random()}`,
				participantId,
				emoji,
				timestamp: Date.now(),
			};

			setActiveReactions((prev) => [...prev, reaction]);

			// Auto-remove after 3 seconds
			setTimeout(() => {
				setActiveReactions((prev) => prev.filter((r) => r.id !== reaction.id));
			}, 3000);
		},
		[roomInfo],
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
		[
			isHandRaised,
			raisedHands,
			activeReactions,
			raiseHand,
			lowerHand,
			toggleHand,
			sendReaction,
		],
	);
}

/**
 * Convenience hook for just hand raise functionality
 */
export function useHandRaise() {
	const {
		isHandRaised,
		raisedHands,
		raisedHandCount,
		raiseHand,
		lowerHand,
		toggleHand,
	} = useInteractions();

	return {
		isHandRaised,
		raisedHands,
		raisedHandCount,
		raiseHand,
		lowerHand,
		toggleHand,
	};
}
