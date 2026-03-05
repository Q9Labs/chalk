import type { Participant, Transcript } from "@q9labs/chalk-core";
import { useCallback, useEffect, useRef, useState } from "react";

import type { MeetingEndData, ParticipantSession, Phase } from "./types";

export interface UseMeetingStatsParams {
	phase: Phase;
	roomId: string;
	participants: readonly Participant[];
	participantCount: number;
	messagesLength: number;
	committedTranscripts: Transcript[];
	recordingId: string | null;
	recordingDurationSeconds: number;
	isLocalScreenSharing: boolean;
	isWhiteboardOpen: boolean;
	activeReactionCount: number;
}

export interface UseMeetingStatsReturn {
	meetingDuration: number;
	incrementHandRaiseCount: () => void;
	buildEndData: () => MeetingEndData;
	resetForRejoin: () => void;
}

export function useMeetingStats({
	phase,
	roomId,
	participants,
	participantCount,
	messagesLength,
	committedTranscripts,
	recordingId,
	recordingDurationSeconds,
	isLocalScreenSharing,
	isWhiteboardOpen,
	activeReactionCount,
}: UseMeetingStatsParams): UseMeetingStatsReturn {
	const [meetingDuration, setMeetingDuration] = useState(0);
	const [joinStartTime, setJoinStartTime] = useState<number | null>(null);

	const participantHistoryRef = useRef<Map<string, ParticipantSession>>(new Map());
	const peakParticipantCountRef = useRef(0);
	const meetingStartTimeRef = useRef<Date | null>(null);
	const reactionCountRef = useRef(0);
	const handRaiseCountRef = useRef(0);
	const screenShareCountRef = useRef(0);
	const whiteboardOpenedRef = useRef(false);
	const prevScreenShareStateRef = useRef(false);
	const prevReactionCountRef = useRef(0);

	useEffect(() => {
		if (phase === "meeting" && !joinStartTime) {
			setJoinStartTime(Date.now());
		}
	}, [phase, joinStartTime]);

	useEffect(() => {
		if (phase !== "meeting" || !joinStartTime) return;

		const interval = setInterval(() => {
			setMeetingDuration(Math.floor((Date.now() - joinStartTime) / 1000));
		}, 1000);

		return () => clearInterval(interval);
	}, [phase, joinStartTime]);

	useEffect(() => {
		if (phase === "meeting" && !meetingStartTimeRef.current) {
			meetingStartTimeRef.current = new Date();
		}
	}, [phase]);

	useEffect(() => {
		if (phase !== "meeting") return;

		if (participantCount > peakParticipantCountRef.current) {
			peakParticipantCountRef.current = participantCount;
		}

		for (const participant of participants) {
			if (!participantHistoryRef.current.has(participant.id)) {
				const externalId = (participant.metadata?.externalId as string) ?? null;
				participantHistoryRef.current.set(participant.id, {
					id: participant.id,
					externalId,
					displayName: participant.displayName,
					role: participant.role as "host" | "participant",
					joinedAt: participant.joinedAt ?? new Date(),
					leftAt: null,
				});
			}
		}

		const currentIds = new Set(participants.map((participant) => participant.id));
		for (const [participantId, session] of participantHistoryRef.current) {
			if (!currentIds.has(participantId) && session.leftAt === null) {
				session.leftAt = new Date();
			}
		}
	}, [phase, participants, participantCount]);

	useEffect(() => {
		if (isLocalScreenSharing && !prevScreenShareStateRef.current) {
			screenShareCountRef.current += 1;
		}
		prevScreenShareStateRef.current = isLocalScreenSharing;
	}, [isLocalScreenSharing]);

	useEffect(() => {
		if (isWhiteboardOpen) {
			whiteboardOpenedRef.current = true;
		}
	}, [isWhiteboardOpen]);

	useEffect(() => {
		if (activeReactionCount > prevReactionCountRef.current) {
			reactionCountRef.current += activeReactionCount - prevReactionCountRef.current;
		}
		prevReactionCountRef.current = activeReactionCount;
	}, [activeReactionCount]);

	const incrementHandRaiseCount = useCallback(() => {
		handRaiseCountRef.current += 1;
	}, []);

	const buildEndData = useCallback((): MeetingEndData => {
		const endedAt = new Date();
		const participantSessions = Array.from(participantHistoryRef.current.values());
		const hostSession = participantSessions.find(
			(participantSession) => participantSession.role === "host",
		);

		return {
			roomId,
			duration: meetingDuration,
			participantCount: Math.max(peakParticipantCountRef.current, participantCount),
			transcripts: committedTranscripts,
			recordingId,
			totalParticipants: participantSessions.length,
			participants: participantSessions,
			hostId: hostSession?.id ?? null,
			startedAt: meetingStartTimeRef.current ?? endedAt,
			endedAt,
			stats: {
				chatMessageCount: messagesLength,
				reactionCount: reactionCountRef.current,
				handRaiseCount: handRaiseCountRef.current,
				screenShareCount: screenShareCountRef.current,
				whiteboardOpened: whiteboardOpenedRef.current,
				recordingDuration: recordingDurationSeconds,
			},
		};
	}, [
		roomId,
		meetingDuration,
		participantCount,
		committedTranscripts,
		recordingId,
		messagesLength,
		recordingDurationSeconds,
	]);

	const resetForRejoin = useCallback(() => {
		setMeetingDuration(0);
		setJoinStartTime(null);
		participantHistoryRef.current.clear();
		peakParticipantCountRef.current = 0;
		meetingStartTimeRef.current = null;
		reactionCountRef.current = 0;
		handRaiseCountRef.current = 0;
		screenShareCountRef.current = 0;
		whiteboardOpenedRef.current = false;
		prevScreenShareStateRef.current = false;
		prevReactionCountRef.current = 0;
	}, []);

	return {
		meetingDuration,
		incrementHandRaiseCount,
		buildEndData,
		resetForRejoin,
	};
}
