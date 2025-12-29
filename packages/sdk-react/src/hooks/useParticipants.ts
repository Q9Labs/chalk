/**
 * useParticipants hook - Access participant list and local participant
 * Works with Chalk Room which wraps RealtimeKit internally
 */

import type { Participant } from "@q9labs/chalk-core";
import { useCallback, useEffect, useState } from "react";
import { useChalk } from "../context.tsx";

export interface UseParticipantsResult {
	/** All participants including local */
	participants: Participant[];
	/** The local participant */
	localParticipant: Participant | null;
	/** Current active speaker */
	activeSpeaker: Participant | null;
	/** Total participant count */
	participantCount: number;
}

export function useParticipants(): UseParticipantsResult {
	const { room } = useChalk();
	const [participants, setParticipants] = useState<Participant[]>([]);
	const [activeSpeaker, setActiveSpeaker] = useState<Participant | null>(null);

	const updateParticipants = useCallback(() => {
		if (room) {
			setParticipants(Array.from(room.participants.values()));
			setActiveSpeaker(room.activeSpeaker);
		} else {
			setParticipants([]);
			setActiveSpeaker(null);
		}
	}, [room]);

	useEffect(() => {
		if (!room) return;

		// Initial sync
		updateParticipants();

		// Subscribe to participant events
		const unsubJoined = room.on("participant-joined", updateParticipants);
		const unsubLeft = room.on("participant-left", updateParticipants);
		const unsubUpdated = room.on("participant-updated", updateParticipants);
		const unsubSpeaker = room.on("active-speaker-changed", (speaker) => {
			setActiveSpeaker(speaker);
		});

		return () => {
			unsubJoined();
			unsubLeft();
			unsubUpdated();
			unsubSpeaker();
		};
	}, [room, updateParticipants]);

	const localParticipant = room?.localParticipant ?? null;

	return {
		participants,
		localParticipant,
		activeSpeaker,
		participantCount: participants.length,
	};
}
