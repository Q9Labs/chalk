/**
 * useParticipants hook - Access participant list via API WebSocket
 * Uses RTK only for media tracks when available
 */

import type { Participant } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeKitParticipant } from "@cloudflare/realtimekit";
import { useChalk } from "../ChalkProvider";
import { logger } from "../logger";

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

// Convert RTK participant to Chalk Participant type (fallback)
function toChalkParticipantFromRtk(
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
	const { wsClient, wsConnectionState, wsParticipantId, rtkClient, roomInfo } =
		useChalk();
	const [participants, setParticipants] = useState<Participant[]>([]);
	// Active speaker detection requires additional RTK integration (future)
	const [activeSpeaker] = useState<Participant | null>(null);
	// Track previous participant IDs for join/leave detection
	const prevParticipantIds = useRef<Set<string>>(new Set());

	const localId = wsParticipantId ?? roomInfo?.participantId ?? null;

	const logParticipantChanges = useCallback((all: Participant[]) => {
		const currentIds = new Set(all.map((p) => p.id));
		const prevIds = prevParticipantIds.current;

		for (const p of all) {
			if (!prevIds.has(p.id)) {
				logger.info({
					event: "participants.join",
					participant: {
						id: p.id,
						displayName: p.displayName,
						role: p.role,
						isLocal: p.isLocal,
					},
					participantCount: all.length,
				});
			}
		}

		for (const id of prevIds) {
			if (!currentIds.has(id)) {
				logger.info({
					event: "participants.leave",
					participantId: id,
					participantCount: all.length,
				});
			}
		}

		if (prevIds.size !== currentIds.size) {
			logger.info({
				event: "participants.update",
				previousCount: prevIds.size,
				currentCount: all.length,
			});
		}

		prevParticipantIds.current = currentIds;
	}, []);

	useEffect(() => {
		if (!wsClient) {
			return;
		}

		const unsubscribeSnapshot = wsClient.on("room.snapshot", (snapshot) => {
			const next = snapshot.participants.map((p) => ({
				...p,
				isLocal: localId ? p.id === localId : p.isLocal,
			}));
			logParticipantChanges(next);
			setParticipants(next);
		});

		const unsubscribeSync = wsClient.on("room-sync", (snapshot) => {
			const next = snapshot.participants.map((p) => ({
				...p,
				isLocal: localId ? p.id === localId : p.isLocal,
			}));
			logParticipantChanges(next);
			setParticipants(next);
		});

		const unsubscribeJoined = wsClient.on("participant.joined", (participant) => {
			setParticipants((prev) => {
				const exists = prev.some((p) => p.id === participant.id);
				if (exists) return prev;
				const next = [
					...prev,
					{
						...participant,
						isLocal: localId ? participant.id === localId : participant.isLocal,
					},
				];
				logParticipantChanges(next);
				return next;
			});
		});

		const unsubscribeLeft = wsClient.on("participant.left", ({ participantId }) => {
			setParticipants((prev) => {
				const next = prev.filter((p) => p.id !== participantId);
				logParticipantChanges(next);
				return next;
			});
		});

		const unsubscribeUpdated = wsClient.on(
			"participant.updated",
			({ participantId, changes }) => {
				setParticipants((prev) => {
					const next = prev.map((p) =>
						p.id === participantId ? { ...p, ...changes } : p,
					);
					return next;
				});
			},
		);

		return () => {
			unsubscribeSnapshot();
			unsubscribeSync();
			unsubscribeJoined();
			unsubscribeLeft();
			unsubscribeUpdated();
		};
	}, [wsClient, localId, logParticipantChanges]);

	useEffect(() => {
		setParticipants((prev) =>
			prev.map((p) => ({
				...p,
				isLocal: localId ? p.id === localId : p.isLocal,
			})),
		);
	}, [localId]);

	useEffect(() => {
		if (wsClient && wsConnectionState === "connected") return;
		if (!rtkClient) {
			return;
		}

		const rtkParticipants = rtkClient.participants.toArray?.() ?? [];
		const remotes = rtkParticipants.map((p: RealtimeKitParticipant) =>
			toChalkParticipantFromRtk(p, false),
		);
		const localParticipantFallback = localId
			? {
					id: localId,
					displayName: roomInfo?.room?.name || "You",
					role: roomInfo?.role || "participant",
					isLocal: true,
					videoEnabled: rtkClient.self?.videoEnabled ?? false,
					audioEnabled: rtkClient.self?.audioEnabled ?? false,
					isSpeaking: false,
					isScreenSharing: rtkClient.self?.screenShareEnabled ?? false,
					handRaised: false,
					connectionQuality: 100,
					videoTrack: rtkClient.self?.videoTrack ?? undefined,
					audioTrack: rtkClient.self?.audioTrack ?? undefined,
				}
			: null;

		const all = localParticipantFallback
			? [localParticipantFallback, ...remotes]
			: remotes;
		setParticipants(all);
	}, [
		wsClient,
		wsConnectionState,
		rtkClient,
		localId,
		roomInfo?.room?.name,
		roomInfo?.role,
	]);

	const enrichedParticipants = useMemo(() => {
		if (!rtkClient) {
			return participants;
		}
		const rtkParticipants = rtkClient.participants.toArray?.() ?? [];
		const rtkMap = new Map(
			rtkParticipants.map((p: RealtimeKitParticipant) => [p.id, p]),
		);
		return participants.map((p) => {
			const rtk =
				(localId && p.id === localId ? rtkClient.self : undefined) ??
				rtkMap.get(p.id);
			if (!rtk) return p;
			const base = wsClient
				? p
				: {
						...p,
						videoEnabled: rtk.videoEnabled ?? p.videoEnabled,
						audioEnabled: rtk.audioEnabled ?? p.audioEnabled,
						isScreenSharing: rtk.screenShareEnabled ?? p.isScreenSharing,
					};
			return {
				...base,
				videoTrack: rtk.videoTrack ?? p.videoTrack,
				audioTrack: rtk.audioTrack ?? p.audioTrack,
			};
		});
	}, [participants, rtkClient, localId, wsClient]);

	const localParticipant = useMemo(
		() => enrichedParticipants.find((p) => p.id === localId) ?? null,
		[enrichedParticipants, localId],
	);

	const remoteParticipants = useMemo(
		() => enrichedParticipants.filter((p) => !p.isLocal),
		[enrichedParticipants],
	);

	const getParticipant = useCallback(
		(id: string) => enrichedParticipants.find((p) => p.id === id),
		[enrichedParticipants],
	);

	return {
		participants: enrichedParticipants,
		localParticipant,
		remoteParticipants,
		activeSpeaker,
		participantCount: enrichedParticipants.length,
		getParticipant,
	};
}
