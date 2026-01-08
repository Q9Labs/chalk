"use client";

/**
 * useParticipants - Access participant list from ParticipantManager
 */

import type { Participant, ParticipantState } from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../context/chalk-provider";

export interface UseParticipantsReturn {
	/** All participants including local */
	participants: readonly Participant[];
	/** The local participant */
	localParticipant: Participant | null;
	/** Remote participants only */
	remoteParticipants: readonly Participant[];
	/** Current active speaker */
	activeSpeaker: Participant | null;
	/** Total participant count */
	participantCount: number;
	/** Get a participant by ID */
	getParticipant: (id: string) => Participant | undefined;
}

/**
 * Hook to access the participant list
 *
 * @example
 * ```tsx
 * function ParticipantGrid() {
 *   const { participants, activeSpeaker } = useParticipants();
 *
 *   return (
 *     <div className="grid">
 *       {participants.map(p => (
 *         <VideoTile
 *           key={p.id}
 *           participant={p}
 *           isSpeaking={activeSpeaker?.id === p.id}
 *         />
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useParticipants(): UseParticipantsReturn {
	const session = useSession();
	const { participants: manager } = session;

	const [state, setState] = useState<ParticipantState>(() => manager.getState());

	useEffect(() => {
		return manager.subscribe(setState);
	}, [manager]);

	const getParticipant = useMemo(
		() => (id: string) => manager.getParticipant(id),
		[manager],
	);

	return useMemo(
		(): UseParticipantsReturn => ({
			participants: state.participants,
			localParticipant: state.localParticipant,
			remoteParticipants: manager.remoteParticipants,
			activeSpeaker: state.activeSpeaker,
			participantCount: state.count,
			getParticipant,
		}),
		[state, manager, getParticipant],
	);
}
