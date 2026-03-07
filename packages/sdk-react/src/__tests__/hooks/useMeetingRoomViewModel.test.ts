import { describe, expect, it } from "bun:test";
import { renderHook } from "@testing-library/react";

import { useMeetingRoomViewModel } from "../../components/full/video-conference/useMeetingRoomViewModel";

describe("useMeetingRoomViewModel", () => {
	it("marks remote participants as hand-raised from interaction state", () => {
		const { result } = renderHook(() =>
			useMeetingRoomViewModel({
				participants: [
					{
						id: "remote-1",
						displayName: "Alice",
						isLocal: false,
						audioEnabled: true,
						videoEnabled: true,
						isScreenSharing: false,
						handRaised: false,
						connectionQuality: 100,
					} as any,
				],
				activeSpeakerId: undefined,
				userName: "Me",
				media: {
					isAudioEnabled: true,
					isVideoEnabled: true,
					selectedSpeaker: null,
				},
				screenShare: {
					isLocalSharing: false,
					videoTrack: null,
				},
				interactions: {
					isHandRaised: false,
					raisedHands: ["remote-1"],
				},
				messages: [],
				localParticipantId: "local-1",
				defaultsLayout: "grid",
				layout: "grid",
				lobbySelectedSpeaker: undefined,
				localRole: "participant",
			}),
		);

		expect(result.current.allParticipants[0]?.isHandRaised).toBe(true);
	});

	it("keeps local hand-raised state from interaction manager when participant snapshot is stale", () => {
		const { result } = renderHook(() =>
			useMeetingRoomViewModel({
				participants: [],
				activeSpeakerId: undefined,
				userName: "Me",
				media: {
					isAudioEnabled: true,
					isVideoEnabled: true,
					selectedSpeaker: null,
				},
				screenShare: {
					isLocalSharing: false,
					videoTrack: null,
				},
				interactions: {
					isHandRaised: true,
					raisedHands: ["local-1"],
				},
				messages: [],
				localParticipantId: "local-1",
				defaultsLayout: "grid",
				layout: "grid",
				lobbySelectedSpeaker: undefined,
				localRole: "participant",
			}),
		);

		expect(result.current.localMeetingParticipant.isHandRaised).toBe(true);
	});
});
