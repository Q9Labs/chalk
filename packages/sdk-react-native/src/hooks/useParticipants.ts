/**
 * useParticipants hook - Access participant list via RTK
 * Integrates with @cloudflare/realtimekit-react-native
 */

import type { Participant } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useChalk } from "../ChalkProvider";
import type { RealtimeKitParticipant } from "@cloudflare/realtimekit";

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

// Convert RTK participant to Chalk Participant type
function toChalkParticipant(
	rtkParticipant: RealtimeKitParticipant,
	isLocal = false,
): Participant {
	return {
		id: rtkParticipant.id,
		displayName: rtkParticipant.name || "Unknown",
		role: "participant",
		isLocal,
		videoEnabled: rtkParticipant.videoEnabled,
		audioEnabled: rtkParticipant.audioEnabled,
		isSpeaking: false,
		isScreenSharing: rtkParticipant.screenShareEnabled ?? false,
		handRaised: false,
		connectionQuality: 100,
		videoTrack: rtkParticipant.videoTrack ?? undefined,
		audioTrack: rtkParticipant.audioTrack ?? undefined,
	};
}

export function useParticipants(): UseParticipantsResult {
	const { rtkClient, roomInfo } = useChalk();
	const [participants, setParticipants] = useState<Participant[]>([]);
	// Active speaker detection requires additional RTK integration (future)
	const [activeSpeaker] = useState<Participant | null>(null);

	// Build local participant from roomInfo and RTK self
	const localParticipant = useMemo<Participant | null>(() => {
		if (!roomInfo) return null;

		const selfState = rtkClient?.self;
		return {
			id: roomInfo.participantId,
			displayName: roomInfo.room?.name || "You",
			role: roomInfo.role || "participant",
			isLocal: true,
			videoEnabled: selfState?.videoEnabled ?? false,
			audioEnabled: selfState?.audioEnabled ?? false,
			isSpeaking: false,
			isScreenSharing: selfState?.screenShareEnabled ?? false,
			handRaised: false,
			connectionQuality: 100,
			videoTrack: selfState?.videoTrack ?? undefined,
			audioTrack: selfState?.audioTrack ?? undefined,
		};
	}, [roomInfo, rtkClient?.self]);

	const updateParticipants = useCallback(() => {
		if (!rtkClient) {
			setParticipants(localParticipant ? [localParticipant] : []);
			return;
		}

		// Get remote participants from RTK
		const rtkParticipants = rtkClient.participants.toArray?.() ?? [];
		const remotes = rtkParticipants.map((p: RealtimeKitParticipant) =>
			toChalkParticipant(p, false),
		);

		// Combine local + remote
		const all = localParticipant ? [localParticipant, ...remotes] : remotes;
		setParticipants(all);
	}, [rtkClient, localParticipant]);

	useEffect(() => {
		if (!rtkClient) return;

		// Initial sync
		updateParticipants();

		// Subscribe to RTK participant events
		const unsubJoined = rtkClient.participants.joined?.on?.(
			"participantJoined",
			updateParticipants,
		);
		const unsubLeft = rtkClient.participants.joined?.on?.(
			"participantLeft",
			updateParticipants,
		);
		const unsubVideo = rtkClient.participants.joined?.on?.(
			"videoUpdate",
			updateParticipants,
		);
		const unsubAudio = rtkClient.participants.joined?.on?.(
			"audioUpdate",
			updateParticipants,
		);

		return () => {
			unsubJoined?.();
			unsubLeft?.();
			unsubVideo?.();
			unsubAudio?.();
		};
	}, [rtkClient, updateParticipants]);

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
