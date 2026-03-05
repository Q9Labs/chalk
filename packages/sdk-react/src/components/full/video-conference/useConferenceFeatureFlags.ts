import type { Participant } from "@q9labs/chalk-core";
import { useMemo } from "react";

import type { FeatureContext, Features, FeatureValue } from "./types";

export interface UseConferenceFeatureFlagsParams {
	features: Features;
	participants: readonly Participant[];
	localParticipant: Participant | null;
	participantCount: number;
	isRecording: boolean;
}

export interface ConferenceFeatureFlags {
	chat: boolean;
	recording: boolean;
	screenShare: boolean;
	whiteboard: boolean;
	reactions: boolean;
	handRaise: boolean;
	tour: boolean;
}

const resolveFeature = (
	feature: FeatureValue | undefined,
	ctx: FeatureContext,
): boolean => {
	if (feature === undefined) return true;
	if (typeof feature === "function") return feature(ctx);
	return feature;
};

export function useConferenceFeatureFlags({
	features,
	participants,
	localParticipant,
	participantCount,
	isRecording,
}: UseConferenceFeatureFlagsParams): ConferenceFeatureFlags {
	const {
		chat: chatFeature,
		recording: recordingFeature,
		screenShare: screenShareFeature,
		whiteboard: whiteboardFeature,
		reactions: reactionsFeature,
		handRaise: handRaiseFeature,
		tour: tourFeature,
	} = features;

	return useMemo(() => {
		const ctx: FeatureContext = {
			participants,
			localParticipant,
			participantCount,
			isRecording,
		};
		return {
			chat: resolveFeature(chatFeature, ctx),
			recording: resolveFeature(recordingFeature, ctx),
			screenShare: resolveFeature(screenShareFeature, ctx),
			whiteboard: resolveFeature(whiteboardFeature, ctx),
			reactions: resolveFeature(reactionsFeature, ctx),
			handRaise: resolveFeature(handRaiseFeature, ctx),
			tour: resolveFeature(tourFeature, ctx),
		};
	}, [
		chatFeature,
		recordingFeature,
		screenShareFeature,
		whiteboardFeature,
		reactionsFeature,
		handRaiseFeature,
		tourFeature,
		participants,
		localParticipant,
		participantCount,
		isRecording,
	]);
}
