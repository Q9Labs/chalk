import { beforeEach, describe, expect, it, vi } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { VideoConference } from "../../components/full/VideoConference";

const mockParticipantsState: {
	participants: any[];
	localParticipant: any;
	participantCount: number;
} = {
	participants: [],
	localParticipant: null,
	participantCount: 0,
};

const mockMediaState: {
	selectedCamera: string | null;
	selectedMicrophone: string | null;
	selectedSpeaker: string | null;
	isAudioEnabled: boolean;
	isVideoEnabled: boolean;
} = {
	selectedCamera: null,
	selectedMicrophone: null,
	selectedSpeaker: null,
	isAudioEnabled: false,
	isVideoEnabled: false,
};

const mockRoomState: {
	isConnected: boolean;
	status: "connected" | "connecting" | "reconnecting" | "disconnected" | "failed";
} = {
	isConnected: false,
	status: "disconnected",
};

vi.mock("../../hooks/room/useConnection", () => {
	const join = vi.fn(async () => {});
	const leave = vi.fn(async () => {});
	(globalThis as any).__vcJoinMock = join;
	return {
		useConnection: () => ({ join, leave, isJoining: false }),
	};
});

vi.mock("../../hooks/room/useRoom", () => ({
	useRoom: () => ({
		isConnected: mockRoomState.isConnected,
		status: mockRoomState.status,
	}),
}));

vi.mock("../../hooks/participants/useParticipants", () => ({
	useParticipants: () => ({
		participants: mockParticipantsState.participants,
		localParticipant: mockParticipantsState.localParticipant,
		participantCount: mockParticipantsState.participantCount,
	}),
}));

vi.mock("../../hooks/participants/useActiveSpeaker", () => ({
	useActiveSpeaker: () => ({ activeSpeaker: null }),
}));

vi.mock("../../hooks/stream/useMedia", () => {
	const selectCamera = vi.fn(async () => {});
	const selectMicrophone = vi.fn(async () => {});
	const selectSpeaker = vi.fn(async (deviceId: string) => {
		mockMediaState.selectedSpeaker = deviceId;
	});
	(globalThis as any).__vcSelectCameraMock = selectCamera;
	(globalThis as any).__vcSelectMicrophoneMock = selectMicrophone;
	(globalThis as any).__vcSelectSpeakerMock = selectSpeaker;
	return {
		useMedia: () => ({
			selectedCamera: mockMediaState.selectedCamera,
			selectedMicrophone: mockMediaState.selectedMicrophone,
			selectedSpeaker: mockMediaState.selectedSpeaker,
			selectCamera,
			selectMicrophone,
			selectSpeaker,
			toggleAudio: vi.fn(),
			toggleVideo: vi.fn(),
			isAudioEnabled: mockMediaState.isAudioEnabled,
			isVideoEnabled: mockMediaState.isVideoEnabled,
		}),
	};
});

vi.mock("../../hooks/stream/useScreenShare", () => ({
	useScreenShare: () => ({
		isLocalSharing: false,
		videoTrack: null,
		toggle: vi.fn(async () => {}),
	}),
}));

vi.mock("../../hooks/features/useChat", () => ({
	useChat: () => ({
		messages: [],
		sendMessage: vi.fn(),
		unreadCount: 0,
		markAsRead: vi.fn(),
	}),
}));

vi.mock("../../hooks/features/useRecording", () => ({
	useRecording: () => ({
		isRecording: false,
		recordingId: null,
		durationSeconds: 0,
		toggle: vi.fn(),
	}),
}));

vi.mock("../../hooks/features/useInteractions", () => ({
	useInteractions: () => ({
		isHandRaised: false,
		activeReactions: [],
		toggleHand: vi.fn(),
		sendReaction: vi.fn(),
	}),
}));

vi.mock("../../hooks/features/useWhiteboard", () => ({
	useWhiteboard: () => ({ isOpen: false }),
}));

vi.mock("../../hooks/features/useTranscripts", () => ({
	useTranscripts: () => ({ transcripts: [] }),
}));

vi.mock("../../hooks/ui/useLayout", () => ({
	useLayout: () => ({ layout: "grid" }),
}));

vi.mock("../../hooks/ui/usePanels", () => ({
	usePanels: () => ({ activePanel: null }),
}));

vi.mock("../../hooks/stream/useDevices", () => ({
	useDevices: () => ({
		refreshDevices: vi.fn(async () => []),
		cameras: [
			{ deviceId: "cam-1", kind: "videoinput", label: "Camera 1" },
			{ deviceId: "cam-2", kind: "videoinput", label: "Camera 2" },
		],
		microphones: [
			{ deviceId: "mic-1", kind: "audioinput", label: "Microphone 1" },
			{ deviceId: "mic-2", kind: "audioinput", label: "Microphone 2" },
		],
		speakers: [{ deviceId: "spk-1", kind: "audiooutput", label: "Speaker 1" }],
	}),
}));

vi.mock("../../context/chalk-provider", () => ({
	useChalkSession: () => ({
		session: {
			on: vi.fn(() => () => {}),
			room: { getState: () => ({ status: "connected" }) },
		},
	}),
}));

vi.mock("../../hooks/useSoundEffects", () => ({
	useSoundEffects: () => ({ play: vi.fn() }),
}));

// @ts-ignore
window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
global.MediaStream = vi
	.fn()
	.mockImplementation((tracks: any[] = []) => ({ getAudioTracks: () => tracks })) as any;

describe("VideoConference pre-join devices", () => {
	beforeEach(() => {
		mockParticipantsState.participants = [];
		mockParticipantsState.localParticipant = null;
		mockParticipantsState.participantCount = 0;
		mockMediaState.selectedCamera = null;
		mockMediaState.selectedMicrophone = null;
		mockMediaState.selectedSpeaker = null;
		mockMediaState.isAudioEnabled = false;
		mockMediaState.isVideoEnabled = false;
		mockRoomState.isConnected = false;
		mockRoomState.status = "disconnected";
		(globalThis as any).__vcJoinMock?.mockClear?.();
		(globalThis as any).__vcSelectCameraMock?.mockClear?.();
		(globalThis as any).__vcSelectMicrophoneMock?.mockClear?.();
		(globalThis as any).__vcSelectSpeakerMock?.mockClear?.();
	});

	it("applies selected lobby camera/mic after join instead of before join", async () => {
		const { getByLabelText, getByText } = render(
			<VideoConference
				roomId="room-123"
				userName="Hasan"
				defaults={{ videoEnabled: false, audioEnabled: false }}
			/>,
		);

		await act(async () => {
			fireEvent.click(getByLabelText("Select camera"));
		});
		await act(async () => {
			fireEvent.click(getByText("Camera 2"));
		});

		await act(async () => {
			fireEvent.click(getByLabelText("Select microphone"));
		});
		await act(async () => {
			fireEvent.click(getByText("Microphone 2"));
		});

		await act(async () => {
			fireEvent.click(getByText("Ask to join"));
		});

		await waitFor(() => {
			expect((globalThis as any).__vcJoinMock).toHaveBeenCalledTimes(1);
		});
		await waitFor(() => {
			expect((globalThis as any).__vcSelectCameraMock).toHaveBeenCalledWith(
				"cam-2",
			);
		});
		await waitFor(() => {
			expect((globalThis as any).__vcSelectMicrophoneMock).toHaveBeenCalledWith(
				"mic-2",
			);
		});
		await waitFor(() => {
			expect((globalThis as any).__vcSelectSpeakerMock).toHaveBeenCalledWith(
				"spk-1",
			);
		});
		expect(
			(globalThis as any).__vcSelectCameraMock.mock.invocationCallOrder[0],
		).toBeGreaterThan((globalThis as any).__vcJoinMock.mock.invocationCallOrder[0]);
		expect(
			(globalThis as any).__vcSelectMicrophoneMock.mock.invocationCallOrder[0],
		).toBeGreaterThan((globalThis as any).__vcJoinMock.mock.invocationCallOrder[0]);
		expect(
			(globalThis as any).__vcSelectSpeakerMock.mock.invocationCallOrder[0],
		).toBeGreaterThan((globalThis as any).__vcJoinMock.mock.invocationCallOrder[0]);
	});

	it("retries transient join failures before surfacing an error", async () => {
		const joinMock = (globalThis as any).__vcJoinMock;
		const onError = vi.fn();
		joinMock
			.mockRejectedValueOnce({
				code: "CONNECTION_FAILED",
				message: "Failed to fetch",
			})
			.mockResolvedValueOnce(undefined);

		const { getByText } = render(
			<VideoConference
				roomId="room-123"
				userName="Hasan"
				onError={onError}
			/>,
		);

		await act(async () => {
			fireEvent.click(getByText("Ask to join"));
		});

		await waitFor(
			() => {
				expect(joinMock).toHaveBeenCalledTimes(2);
			},
			{ timeout: 3000 },
		);
		expect(onError).not.toHaveBeenCalled();
	});

	it("uses connection retry CTA to re-attempt join with previous settings", async () => {
		const joinMock = (globalThis as any).__vcJoinMock;
		mockRoomState.status = "disconnected";

		const { getByText } = render(
			<VideoConference
				roomId="room-123"
				userName="Hasan"
			/>,
		);

		await act(async () => {
			fireEvent.click(getByText("Ask to join"));
		});

		await waitFor(() => {
			expect(joinMock).toHaveBeenCalledTimes(1);
		});

		await waitFor(() => {
			expect(getByText("Try Again")).toBeTruthy();
		});

		await act(async () => {
			fireEvent.click(getByText("Try Again"));
		});

		await waitFor(() => {
			expect(joinMock).toHaveBeenCalledTimes(2);
		});

		expect(joinMock).toHaveBeenNthCalledWith(
			1,
			"room-123",
			expect.objectContaining({ userName: "Hasan" }),
		);
		expect(joinMock).toHaveBeenNthCalledWith(
			2,
			"room-123",
			expect.objectContaining({ userName: "Hasan" }),
		);
	});

	it("emits enriched join telemetry after retries are exhausted", async () => {
		const joinMock = (globalThis as any).__vcJoinMock;
		const onError = vi.fn();
		joinMock.mockRejectedValue({
			code: "CONNECTION_FAILED",
			message: "Failed to fetch",
		});

		const { getByText } = render(
			<VideoConference
				roomId="room-123"
				userName="Hasan"
				onError={onError}
			/>,
		);

		await act(async () => {
			fireEvent.click(getByText("Ask to join"));
		});

		await waitFor(
			() => {
				expect(joinMock).toHaveBeenCalledTimes(3);
			},
			{ timeout: 5000 },
		);

		await waitFor(() => {
			expect(onError).toHaveBeenCalledTimes(1);
		});

		const emitted = onError.mock.calls[0][0];
		expect(emitted.details?.joinRetryExhausted).toBe(true);
		expect(emitted.details?.joinStage).toBe("join_api");
		expect(emitted.details?.phase).toBe("joining");
		expect(emitted.details?.roomId).toBe("room-123");
	});
});
