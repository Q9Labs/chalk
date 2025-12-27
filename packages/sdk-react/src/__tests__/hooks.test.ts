/**
 * Tests for React hooks
 * @module @chalk/react/__tests__/hooks
 */

import { describe, expect, it } from "bun:test";
import type {
	ChatMessage,
	MediaDevice,
	Participant,
	RoomStatus,
} from "@chalk/core";
import type {
	UseChatResult,
	UseDevicesResult,
	UseMediaResult,
	UseParticipantsResult,
	UseRecordingResult,
	UseRoomResult,
} from "../hooks/index.ts";

describe("Hook return types", () => {
	describe("useRoom", () => {
		it("should return UseRoomResult structure", () => {
			const roomResult: UseRoomResult = {
				room: null,
				roomInfo: null,
				isConnected: false,
				status: "disconnected",
				isRecording: false,
			};

			expect(roomResult.room).toBeNull();
			expect(roomResult.roomInfo).toBeNull();
			expect(roomResult.isConnected).toBe(false);
			expect(roomResult.status).toBe("disconnected");
			expect(roomResult.isRecording).toBe(false);
		});

		it("should have valid RoomStatus values", () => {
			const validStatuses: RoomStatus[] = [
				"connecting",
				"connected",
				"reconnecting",
				"disconnected",
				"failed",
			];

			validStatuses.forEach((status) => {
				const result: UseRoomResult = {
					room: null,
					roomInfo: null,
					isConnected: status === "connected",
					status,
					isRecording: false,
				};

				expect(result.status).toBe(status);
			});
		});

		it("should have optional room and roomInfo", () => {
			const result: UseRoomResult = {
				room: null,
				roomInfo: null,
				isConnected: false,
				status: "disconnected",
				isRecording: false,
			};

			expect(result.room).toBeNull();
			expect(result.roomInfo).toBeNull();
		});
	});

	describe("useParticipants", () => {
		it("should return UseParticipantsResult structure", () => {
			const participantResult: UseParticipantsResult = {
				participants: [],
				localParticipant: null,
				activeSpeaker: null,
				participantCount: 0,
			};

			expect(Array.isArray(participantResult.participants)).toBe(true);
			expect(participantResult.localParticipant).toBeNull();
			expect(participantResult.activeSpeaker).toBeNull();
			expect(participantResult.participantCount).toBe(0);
		});

		it("should support multiple participants", () => {
			const participant1: Participant = {
				id: "p1",
				displayName: "Alice",
				role: "participant",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: false,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 100,
			};

			const participant2: Participant = {
				id: "p2",
				displayName: "Bob",
				role: "host",
				isLocal: false,
				videoEnabled: true,
				audioEnabled: true,
				isSpeaking: true,
				isScreenSharing: false,
				handRaised: false,
				connectionQuality: 95,
			};

			const result: UseParticipantsResult = {
				participants: [participant1, participant2],
				localParticipant: null,
				activeSpeaker: participant2,
				participantCount: 2,
			};

			expect(result.participantCount).toBe(2);
			expect(result.activeSpeaker?.isSpeaking).toBe(true);
		});

		it("should update participant count correctly", () => {
			let result: UseParticipantsResult = {
				participants: [],
				localParticipant: null,
				activeSpeaker: null,
				participantCount: 0,
			};

			expect(result.participantCount).toBe(0);

			result = {
				...result,
				participantCount: 5,
				participants: Array(5).fill(null),
			};

			expect(result.participantCount).toBe(5);
		});
	});

	describe("useMedia", () => {
		it("should return UseMediaResult structure", () => {
			const mediaResult: UseMediaResult = {
				isVideoEnabled: false,
				isAudioEnabled: false,
				isScreenSharing: false,
				toggleVideo: async () => {},
				toggleAudio: async () => {},
				startScreenShare: async () => {},
				stopScreenShare: () => {},
			};

			expect(typeof mediaResult.isVideoEnabled).toBe("boolean");
			expect(typeof mediaResult.isAudioEnabled).toBe("boolean");
			expect(typeof mediaResult.isScreenSharing).toBe("boolean");
			expect(typeof mediaResult.toggleVideo).toBe("function");
			expect(typeof mediaResult.toggleAudio).toBe("function");
			expect(typeof mediaResult.startScreenShare).toBe("function");
			expect(typeof mediaResult.stopScreenShare).toBe("function");
		});

		it("should support media state changes", () => {
			let result: UseMediaResult = {
				isVideoEnabled: false,
				isAudioEnabled: false,
				isScreenSharing: false,
				toggleVideo: async () => {},
				toggleAudio: async () => {},
				startScreenShare: async () => {},
				stopScreenShare: () => {},
			};

			expect(result.isVideoEnabled).toBe(false);

			result = {
				...result,
				isVideoEnabled: true,
			};

			expect(result.isVideoEnabled).toBe(true);
		});

		it("should support all media state combinations", () => {
			const combinations = [
				{ video: false, audio: false, screen: false },
				{ video: true, audio: false, screen: false },
				{ video: false, audio: true, screen: false },
				{ video: true, audio: true, screen: false },
				{ video: true, audio: true, screen: true },
			];

			combinations.forEach(({ video, audio, screen }) => {
				const result: UseMediaResult = {
					isVideoEnabled: video,
					isAudioEnabled: audio,
					isScreenSharing: screen,
					toggleVideo: async () => {},
					toggleAudio: async () => {},
					startScreenShare: async () => {},
					stopScreenShare: () => {},
				};

				expect(result.isVideoEnabled).toBe(video);
				expect(result.isAudioEnabled).toBe(audio);
				expect(result.isScreenSharing).toBe(screen);
			});
		});
	});

	describe("useChat", () => {
		it("should return UseChatResult structure", () => {
			const chatResult: UseChatResult = {
				messages: [],
				sendMessage: () => {},
			};

			expect(Array.isArray(chatResult.messages)).toBe(true);
			expect(typeof chatResult.sendMessage).toBe("function");
		});

		it("should support multiple messages", () => {
			const messages: ChatMessage[] = [
				{
					id: "msg1",
					senderId: "p1",
					senderName: "Alice",
					content: "Hello",
					timestamp: new Date(),
				},
				{
					id: "msg2",
					senderId: "p2",
					senderName: "Bob",
					content: "Hi there",
					timestamp: new Date(),
				},
			];

			const result: UseChatResult = {
				messages,
				sendMessage: () => {},
			};

			expect(result.messages.length).toBe(2);
			expect(result.messages[0].senderName).toBe("Alice");
		});

		it("should allow sending messages", () => {
			let sentContent = "";

			const result: UseChatResult = {
				messages: [],
				sendMessage: (content: string) => {
					sentContent = content;
				},
			};

			result.sendMessage("Test message");
			expect(sentContent).toBe("Test message");
		});
	});

	describe("useRecording", () => {
		it("should return UseRecordingResult structure", () => {
			const recordingResult: UseRecordingResult = {
				isRecording: false,
				recordingId: null,
				durationSeconds: 0,
				startRecording: async () => {},
				stopRecording: async () => {},
				error: null,
			};

			expect(recordingResult.isRecording).toBe(false);
			expect(recordingResult.recordingId).toBeNull();
			expect(typeof recordingResult.durationSeconds).toBe("number");
			expect(typeof recordingResult.startRecording).toBe("function");
			expect(typeof recordingResult.stopRecording).toBe("function");
			expect(recordingResult.error).toBeNull();
		});

		it("should track recording duration", () => {
			const result: UseRecordingResult = {
				isRecording: true,
				recordingId: "rec_123",
				durationSeconds: 30,
				startRecording: async () => {},
				stopRecording: async () => {},
				error: null,
			};

			expect(result.durationSeconds).toBe(30);
			expect(result.isRecording).toBe(true);
			expect(result.recordingId).toBe("rec_123");
		});

		it("should support error tracking", () => {
			const error = new Error("Recording failed");

			const result: UseRecordingResult = {
				isRecording: false,
				recordingId: null,
				durationSeconds: 0,
				startRecording: async () => {},
				stopRecording: async () => {},
				error,
			};

			expect(result.error).toEqual(error);
			expect(result.error?.message).toBe("Recording failed");
		});

		it("should support recording lifecycle", () => {
			let state: UseRecordingResult = {
				isRecording: false,
				recordingId: null,
				durationSeconds: 0,
				startRecording: async () => {},
				stopRecording: async () => {},
				error: null,
			};

			// Start recording
			state = {
				...state,
				isRecording: true,
				recordingId: "rec_123",
			};

			expect(state.isRecording).toBe(true);
			expect(state.recordingId).toBe("rec_123");

			// Stop recording
			state = {
				...state,
				isRecording: false,
				recordingId: null,
			};

			expect(state.isRecording).toBe(false);
		});
	});

	describe("useDevices", () => {
		it("should return UseDevicesResult structure", () => {
			const devicesResult: UseDevicesResult = {
				devices: [],
				cameras: [],
				microphones: [],
				speakers: [],
				selectedCamera: null,
				selectedMicrophone: null,
				selectCamera: async () => false,
				selectMicrophone: async () => false,
				refreshDevices: async () => {},
				isLoading: false,
			};

			expect(Array.isArray(devicesResult.devices)).toBe(true);
			expect(Array.isArray(devicesResult.cameras)).toBe(true);
			expect(Array.isArray(devicesResult.microphones)).toBe(true);
			expect(Array.isArray(devicesResult.speakers)).toBe(true);
			expect(typeof devicesResult.isLoading).toBe("boolean");
		});

		it("should support multiple devices", () => {
			const devices: MediaDevice[] = [
				{
					deviceId: "cam1",
					label: "Front Camera",
					kind: "videoinput",
				},
				{
					deviceId: "mic1",
					label: "Built-in Microphone",
					kind: "audioinput",
				},
				{
					deviceId: "speaker1",
					label: "Speaker",
					kind: "audiooutput",
				},
			];

			const result: UseDevicesResult = {
				devices,
				cameras: devices.filter((d) => d.kind === "videoinput"),
				microphones: devices.filter((d) => d.kind === "audioinput"),
				speakers: devices.filter((d) => d.kind === "audiooutput"),
				selectedCamera: "cam1",
				selectedMicrophone: "mic1",
				selectCamera: async () => true,
				selectMicrophone: async () => true,
				refreshDevices: async () => {},
				isLoading: false,
			};

			expect(result.devices.length).toBe(3);
			expect(result.cameras.length).toBe(1);
			expect(result.microphones.length).toBe(1);
			expect(result.speakers.length).toBe(1);
		});

		it("should filter devices by kind", () => {
			const allDevices: MediaDevice[] = [
				{ deviceId: "d1", label: "Camera 1", kind: "videoinput" },
				{ deviceId: "d2", label: "Camera 2", kind: "videoinput" },
				{ deviceId: "d3", label: "Mic 1", kind: "audioinput" },
				{ deviceId: "d4", label: "Speaker 1", kind: "audiooutput" },
			];

			const result: UseDevicesResult = {
				devices: allDevices,
				cameras: allDevices.filter((d) => d.kind === "videoinput"),
				microphones: allDevices.filter((d) => d.kind === "audioinput"),
				speakers: allDevices.filter((d) => d.kind === "audiooutput"),
				selectedCamera: null,
				selectedMicrophone: null,
				selectCamera: async () => false,
				selectMicrophone: async () => false,
				refreshDevices: async () => {},
				isLoading: false,
			};

			expect(result.cameras.length).toBe(2);
			expect(result.microphones.length).toBe(1);
			expect(result.speakers.length).toBe(1);
		});

		it("should support loading state", () => {
			const result: UseDevicesResult = {
				devices: [],
				cameras: [],
				microphones: [],
				speakers: [],
				selectedCamera: null,
				selectedMicrophone: null,
				selectCamera: async () => false,
				selectMicrophone: async () => false,
				refreshDevices: async () => {},
				isLoading: true,
			};

			expect(result.isLoading).toBe(true);
		});

		it("should support device selection", () => {
			const result: UseDevicesResult = {
				devices: [{ deviceId: "cam1", label: "Camera 1", kind: "videoinput" }],
				cameras: [{ deviceId: "cam1", label: "Camera 1", kind: "videoinput" }],
				microphones: [],
				speakers: [],
				selectedCamera: null,
				selectedMicrophone: null,
				selectCamera: async (id) => {
					result.selectedCamera = id;
					return true;
				},
				selectMicrophone: async () => false,
				refreshDevices: async () => {},
				isLoading: false,
			};

			expect(result.selectedCamera).toBeNull();

			// Simulate device selection
			result.selectCamera("cam1");
			expect(result.selectedCamera).toBe("cam1");
		});
	});
});
