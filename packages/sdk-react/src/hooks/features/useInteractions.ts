/**
 * useInteractions - Reactions and hand raise from InteractionManager
 */

import type {
	ActiveReaction,
	InteractionState,
	ReactionEmoji,
} from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

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
	/** Toggle hand */
	toggleHand: () => void;
	/** Send a floating reaction */
	sendReaction: (emoji: ReactionEmoji) => void;
}

/**
 * Hook for interactions (reactions and hand raise)
 *
 * @example
 * ```tsx
 * function ReactionBar() {
 *   const { sendReaction, isHandRaised, toggleHand, activeReactions } = useInteractions();
 *
 *   return (
 *     <div>
 *       <button onClick={() => sendReaction('👍')}>👍</button>
 *       <button onClick={() => sendReaction('❤️')}>❤️</button>
 *       <button onClick={toggleHand}>
 *         {isHandRaised ? '✋ Lower Hand' : '✋ Raise Hand'}
 *       </button>
 *
 *       {activeReactions.map(r => (
 *         <span key={r.id} className="floating-reaction">{r.emoji}</span>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useInteractions(): UseInteractionsReturn {
	const session = useSession();
	const { interactions } = session;

	const [state, setState] = useState<InteractionState>(() =>
		interactions.getState(),
	);

	useEffect(() => {
		return interactions.subscribe(setState);
	}, [interactions]);

	const raiseHand = useCallback(
		(): void => interactions.raiseHand(),
		[interactions],
	);

	const lowerHand = useCallback(
		(): void => interactions.lowerHand(),
		[interactions],
	);

	const toggleHand = useCallback(
		(): void => interactions.toggleHand(),
		[interactions],
	);

	const sendReaction = useCallback(
		(emoji: ReactionEmoji): void => interactions.sendReaction(emoji),
		[interactions],
	);

	return useMemo(
		(): UseInteractionsReturn => ({
			isHandRaised: state.isHandRaised,
			raisedHands: state.raisedHands,
			raisedHandCount: interactions.raisedHandCount,
			activeReactions: state.activeReactions,
			raiseHand,
			lowerHand,
			toggleHand,
			sendReaction,
		}),
		[state, interactions, raiseHand, lowerHand, toggleHand, sendReaction],
	);
}
