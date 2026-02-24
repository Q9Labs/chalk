import { beforeEach, describe, expect, it, vi } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { VideoConference } from "../../components/full/VideoConference";

vi.mock("../../hooks/room/useConnection", () => {
	const join = vi.fn(async () => {});
	const leave = vi.fn(async () => {});
	(globalThis as any).__vcJoinMock = join;
	return {
		useConnection: () => ({ join, leave, isJoining: false }),
	};
});

vi.mock("../../hooks/room/useRoom", () => ({
	useRoom: () => ({ isConnected: false, status: "disconnected" as const }),
}));

vi.mock("../../hooks/participants/useParticipants", () => ({
	useParticipants: () => ({
		participants: [],
		localParticipant: null,
		participantCount: 0,
	}),
}));

vi.mock("../../hooks/participants/useActiveSpeaker", () => ({
	useActiveSpeaker: () => ({ activeSpeaker: null }),
}));

vi.mock("../../hooks/stream/useMedia", () => {
	const selectCamera = vi.fn(async () => {});
	const selectMicrophone = vi.fn(async () => {});
	const selectSpeaker = vi.fn(async () => {});
	(globalThis as any).__vcSelectCameraMock = selectCamera;
	(globalThis as any).__vcSelectMicrophoneMock = selectMicrophone;
	(globalThis as any).__vcSelectSpeakerMock = selectSpeaker;
	return {
		useMedia: () => ({
			selectedCamera: null,
			selectedMicrophone: null,
			selectedSpeaker: null,
			selectCamera,
			selectMicrophone,
			selectSpeaker,
			toggleAudio: vi.fn(),
			toggleVideo: vi.fn(),
			isAudioEnabled: false,
			isVideoEnabled: false,
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

vi.mock("../../hooks/ui/useParticipantVolume", () => ({
	useParticipantVolume: () => ({
		participantVolumes: new Map(),
		setParticipantVolume: vi.fn(),
		getAudioVolume: () => 1,
	}),
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
global.MediaStream = vi.fn().mockImplementation(() => ({})) as any;

describe("VideoConference pre-join devices", () => {
	beforeEach(() => {
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
		expect(
			(globalThis as any).__vcSelectCameraMock.mock.invocationCallOrder[0],
		).toBeGreaterThan((globalThis as any).__vcJoinMock.mock.invocationCallOrder[0]);
		expect(
			(globalThis as any).__vcSelectMicrophoneMock.mock.invocationCallOrder[0],
		).toBeGreaterThan((globalThis as any).__vcJoinMock.mock.invocationCallOrder[0]);
	});
});
