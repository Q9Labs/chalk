/**
 * useParticipants hook - Access participant list and local participant
 */

import type { Participant } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChalk } from "../ChalkProvider";

export interface UseParticipantsResult {
	/** All participants including local */
	participants: Participant[];
	/** The local participant */
	localParticipant: Participant | null;
	/** Remote participants only (excludes local) */
	remoteParticipants: Participant[];
	/** Current active speaker */
	activeSpeaker: Participant | null;
	/** Total participant count */
	participantCount: number;
	/** Get a participant by ID */
	getParticipant: (id: string) => Participant | undefined;
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

	const remoteParticipants = useMemo(
		() => participants.filter((p) => !p.isLocal),
		[participants],
	);

	const getParticipant = useCallback(
		(id: string) => participants.find((p) => p.id === id),
		[participants],
	);

	return {
		participants,
		localParticipant,
		remoteParticipants,
		activeSpeaker,
		participantCount: participants.length,
		getParticipant,
	};
}
