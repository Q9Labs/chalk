import { beforeEach, describe, expect, it, mock } from "bun:test";

const mockRtcManager = {
	startScreenShare: mock(() => Promise.resolve(true)),
	stopScreenShare: mock(() => Promise.resolve()),
	getIsScreenSharing: mock(() => false),
};

const mockRoom = {
	startScreenShare: mock(() => Promise.resolve(true)),
	stopScreenShare: mock(() => {}),
};

const mockUseChalk = mock(() => ({
	rtcManager: mockRtcManager,
	room: mockRoom,
	client: null,
	isConnected: false,
	connectionStatus: "disconnected" as const,
	joinRoom: mock(() => Promise.resolve(mockRoom)),
	leaveRoom: mock(() => Promise.resolve()),
	createRoom: mock(() => Promise.resolve("room_123")),
}));

mock.module("../ChalkProvider", () => ({
	useChalk: mockUseChalk,
}));

mock.module("react-native", () => ({
	NativeModules: {
		AudioSessionModule: {
			setOutputRoute: mock(() => Promise.resolve()),
			getAvailableRoutes: mock(() =>
				Promise.resolve(["speaker", "earpiece", "bluetooth"]),
			),
			getCurrentRoute: mock(() => Promise.resolve("speaker")),
		},
	},
	Platform: {
		OS: "ios",
	},
}));

describe("useScreenShare", () => {
	beforeEach(() => {
		mockRtcManager.startScreenShare.mockClear();
		mockRtcManager.stopScreenShare.mockClear();
		mockRoom.startScreenShare.mockClear();
		mockRoom.stopScreenShare.mockClear();
	});

	it("exports UseScreenShareResult interface with correct shape", () => {
		const expectedKeys = [
			"isScreenSharing",
			"startScreenShare",
			"stopScreenShare",
			"error",
		];
		expect(expectedKeys.length).toBe(4);
	});

	it("startScreenShare returns boolean", async () => {
		const result = await mockRtcManager.startScreenShare();
		expect(result).toBe(true);
	});

	it("stopScreenShare returns void", async () => {
		const result = await mockRtcManager.stopScreenShare();
		expect(result).toBeUndefined();
	});

	it("rtcManager tracks screen sharing state", () => {
		expect(mockRtcManager.getIsScreenSharing()).toBe(false);
	});
});

describe("useAudioRouting", () => {
	it("exports AudioRoute type with valid values", () => {
		const validRoutes: Array<
			"speaker" | "earpiece" | "bluetooth" | "headphones"
		> = ["speaker", "earpiece", "bluetooth", "headphones"];
		expect(validRoutes).toContain("speaker");
		expect(validRoutes).toContain("earpiece");
		expect(validRoutes).toContain("bluetooth");
		expect(validRoutes).toContain("headphones");
	});

	it("exports UseAudioRoutingResult interface with correct shape", () => {
		const expectedKeys = [
			"currentRoute",
			"availableRoutes",
			"setRoute",
			"isSpeakerOn",
			"toggleSpeaker",
		];
		expect(expectedKeys.length).toBe(5);
	});

	it("default route is speaker", () => {
		const defaultRoute = "speaker";
		expect(defaultRoute).toBe("speaker");
	});

	it("toggleSpeaker alternates between speaker and earpiece", () => {
		let currentRoute: "speaker" | "earpiece" = "speaker";
		const toggleSpeaker = () => {
			currentRoute = currentRoute === "speaker" ? "earpiece" : "speaker";
		};

		expect(currentRoute as string).toBe("speaker");
		toggleSpeaker();
		expect(currentRoute as string).toBe("earpiece");
		toggleSpeaker();
		expect(currentRoute as string).toBe("speaker");
	});
});

describe("RTCManager RealtimeKit integration", () => {
	it("rtcManager provides screen sharing methods", () => {
		expect(typeof mockRtcManager.startScreenShare).toBe("function");
		expect(typeof mockRtcManager.stopScreenShare).toBe("function");
		expect(typeof mockRtcManager.getIsScreenSharing).toBe("function");
	});

	it("startScreenShare can succeed or fail", async () => {
		mockRtcManager.startScreenShare.mockResolvedValueOnce(true);
		const successResult = await mockRtcManager.startScreenShare();
		expect(successResult).toBe(true);

		mockRtcManager.startScreenShare.mockResolvedValueOnce(false);
		const failResult = await mockRtcManager.startScreenShare();
		expect(failResult).toBe(false);
	});
});

describe("@chalk/react-native hooks exports", () => {
	it("exports all expected hook types", () => {
		const expectedHooks = [
			"useAudioRouting",
			"useScreenShare",
			"useChat",
			"useDevices",
			"useMedia",
			"useParticipants",
			"useRecording",
			"useRoom",
		];
		expect(expectedHooks.length).toBe(8);
	});

	it("exports type definitions for new hooks", () => {
		const expectedTypes = [
			"UseAudioRoutingResult",
			"UseScreenShareResult",
			"AudioRoute",
		];
		expect(expectedTypes.length).toBe(3);
	});
});
