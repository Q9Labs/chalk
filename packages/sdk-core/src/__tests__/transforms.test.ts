import { describe, expect, it } from "bun:test";
import {
	camelToSnake,
	camelToSnakeString,
	snakeToCamel,
	snakeToCamelString,
} from "../transforms.ts";

describe("snakeToCamelString", () => {
	it("should convert snake_case to camelCase", () => {
		expect(snakeToCamelString("display_name")).toBe("displayName");
		expect(snakeToCamelString("participant_id")).toBe("participantId");
		expect(snakeToCamelString("access_token")).toBe("accessToken");
		expect(snakeToCamelString("auth_token")).toBe("authToken");
		expect(snakeToCamelString("recording_id")).toBe("recordingId");
		expect(snakeToCamelString("download_url")).toBe("downloadUrl");
		expect(snakeToCamelString("max_participants")).toBe("maxParticipants");
		expect(snakeToCamelString("video_enabled")).toBe("videoEnabled");
	});

	it("should handle strings without underscores", () => {
		expect(snakeToCamelString("id")).toBe("id");
		expect(snakeToCamelString("name")).toBe("name");
	});

	it("should handle multiple underscores", () => {
		expect(snakeToCamelString("is_screen_sharing")).toBe("isScreenSharing");
		expect(snakeToCamelString("hand_raised_at")).toBe("handRaisedAt");
	});

	it("should handle empty string", () => {
		expect(snakeToCamelString("")).toBe("");
	});
});

describe("camelToSnakeString", () => {
	it("should convert camelCase to snake_case", () => {
		expect(camelToSnakeString("displayName")).toBe("display_name");
		expect(camelToSnakeString("participantId")).toBe("participant_id");
		expect(camelToSnakeString("accessToken")).toBe("access_token");
		expect(camelToSnakeString("authToken")).toBe("auth_token");
		expect(camelToSnakeString("recordingId")).toBe("recording_id");
		expect(camelToSnakeString("downloadUrl")).toBe("download_url");
		expect(camelToSnakeString("maxParticipants")).toBe("max_participants");
		expect(camelToSnakeString("videoEnabled")).toBe("video_enabled");
	});

	it("should handle strings without uppercase", () => {
		expect(camelToSnakeString("id")).toBe("id");
		expect(camelToSnakeString("name")).toBe("name");
	});

	it("should handle multiple uppercase letters", () => {
		expect(camelToSnakeString("isScreenSharing")).toBe("is_screen_sharing");
		expect(camelToSnakeString("handRaisedAt")).toBe("hand_raised_at");
	});

	it("should handle empty string", () => {
		expect(camelToSnakeString("")).toBe("");
	});
});

describe("snakeToCamel", () => {
	it("should transform flat object keys", () => {
		const input = {
			display_name: "John",
			participant_id: "123",
			video_enabled: true,
		};

		const result = snakeToCamel<{
			displayName: string;
			participantId: string;
			videoEnabled: boolean;
		}>(input);

		expect(result.displayName).toBe("John");
		expect(result.participantId).toBe("123");
		expect(result.videoEnabled).toBe(true);
	});

	it("should transform nested objects", () => {
		const input = {
			room_id: "room_1",
			participant_info: {
				display_name: "Jane",
				audio_enabled: false,
			},
		};

		const result = snakeToCamel<{
			roomId: string;
			participantInfo: {
				displayName: string;
				audioEnabled: boolean;
			};
		}>(input);

		expect(result.roomId).toBe("room_1");
		expect(result.participantInfo.displayName).toBe("Jane");
		expect(result.participantInfo.audioEnabled).toBe(false);
	});

	it("should transform arrays of objects", () => {
		const input = {
			participants: [
				{ participant_id: "1", display_name: "Alice" },
				{ participant_id: "2", display_name: "Bob" },
			],
		};

		const result = snakeToCamel<{
			participants: Array<{ participantId: string; displayName: string }>;
		}>(input);

		expect(result.participants[0]?.participantId).toBe("1");
		expect(result.participants[0]?.displayName).toBe("Alice");
		expect(result.participants[1]?.participantId).toBe("2");
		expect(result.participants[1]?.displayName).toBe("Bob");
	});

	it("should handle null and undefined", () => {
		expect(snakeToCamel(null)).toBeNull();
		expect(snakeToCamel(undefined)).toBeUndefined();
	});

	it("should pass through primitives", () => {
		expect(snakeToCamel<string>("string")).toBe("string");
		expect(snakeToCamel<number>(123)).toBe(123);
		expect(snakeToCamel<boolean>(true)).toBe(true);
	});

	it("should preserve Date objects", () => {
		const date = new Date("2024-01-01");
		expect(snakeToCamel<Date>(date)).toBe(date);
	});

	it("should handle deeply nested structures", () => {
		const input = {
			outer_key: {
				middle_key: {
					inner_key: {
						deep_value: "test",
					},
				},
			},
		};

		const result = snakeToCamel<{
			outerKey: {
				middleKey: {
					innerKey: {
						deepValue: string;
					};
				};
			};
		}>(input);

		expect(result.outerKey.middleKey.innerKey.deepValue).toBe("test");
	});

	it("should handle room.snapshot payload correctly", () => {
		const input = {
			room_id: "room_123",
			participants: [
				{
					id: "p_1",
					display_name: "Alice",
					video_enabled: true,
					audio_enabled: false,
					is_screen_sharing: false,
					hand_raised: true,
				},
			],
			is_recording: true,
			recording_id: "rec_123",
			last_seq: 42,
		};

		const result = snakeToCamel<{
			roomId: string;
			participants: Array<{
				id: string;
				displayName: string;
				videoEnabled: boolean;
				audioEnabled: boolean;
				isScreenSharing: boolean;
				handRaised: boolean;
			}>;
			isRecording: boolean;
			recordingId: string;
			lastSeq: number;
		}>(input);

		expect(result.roomId).toBe("room_123");
		expect(result.isRecording).toBe(true);
		expect(result.recordingId).toBe("rec_123");
		expect(result.lastSeq).toBe(42);
		expect(result.participants[0]?.displayName).toBe("Alice");
		expect(result.participants[0]?.videoEnabled).toBe(true);
		expect(result.participants[0]?.audioEnabled).toBe(false);
		expect(result.participants[0]?.handRaised).toBe(true);
	});
});

describe("camelToSnake", () => {
	it("should transform flat object keys", () => {
		const input = {
			displayName: "John",
			participantId: "123",
			videoEnabled: true,
		};

		const result = camelToSnake<{
			display_name: string;
			participant_id: string;
			video_enabled: boolean;
		}>(input);

		expect(result.display_name).toBe("John");
		expect(result.participant_id).toBe("123");
		expect(result.video_enabled).toBe(true);
	});

	it("should transform nested objects", () => {
		const input = {
			roomId: "room_1",
			participantInfo: {
				displayName: "Jane",
				audioEnabled: false,
			},
		};

		const result = camelToSnake<{
			room_id: string;
			participant_info: {
				display_name: string;
				audio_enabled: boolean;
			};
		}>(input);

		expect(result.room_id).toBe("room_1");
		expect(result.participant_info.display_name).toBe("Jane");
		expect(result.participant_info.audio_enabled).toBe(false);
	});

	it("should transform arrays of objects", () => {
		const input = {
			participants: [
				{ participantId: "1", displayName: "Alice" },
				{ participantId: "2", displayName: "Bob" },
			],
		};

		const result = camelToSnake<{
			participants: Array<{ participant_id: string; display_name: string }>;
		}>(input);

		expect(result.participants[0]?.participant_id).toBe("1");
		expect(result.participants[0]?.display_name).toBe("Alice");
		expect(result.participants[1]?.participant_id).toBe("2");
		expect(result.participants[1]?.display_name).toBe("Bob");
	});

	it("should handle null and undefined", () => {
		expect(camelToSnake(null)).toBeNull();
		expect(camelToSnake(undefined)).toBeUndefined();
	});

	it("should pass through primitives", () => {
		expect(camelToSnake<string>("string")).toBe("string");
		expect(camelToSnake<number>(123)).toBe(123);
		expect(camelToSnake<boolean>(true)).toBe(true);
	});

	it("should preserve Date objects", () => {
		const date = new Date("2024-01-01");
		expect(camelToSnake<Date>(date)).toBe(date);
	});

	it("should handle API request body correctly", () => {
		const input = {
			roomId: "room_123",
			displayName: "Alice",
			maxParticipants: 10,
			videoEnabled: true,
			audioEnabled: true,
		};

		const result = camelToSnake<{
			room_id: string;
			display_name: string;
			max_participants: number;
			video_enabled: boolean;
			audio_enabled: boolean;
		}>(input);

		expect(result.room_id).toBe("room_123");
		expect(result.display_name).toBe("Alice");
		expect(result.max_participants).toBe(10);
		expect(result.video_enabled).toBe(true);
		expect(result.audio_enabled).toBe(true);
	});
});

describe("round-trip transforms", () => {
	it("should be reversible for simple objects", () => {
		const original = {
			displayName: "John",
			participantId: "123",
			videoEnabled: true,
		};

		const snaked = camelToSnake(original);
		const restored = snakeToCamel<typeof original>(snaked);

		expect(restored).toEqual(original);
	});

	it("should be reversible for nested objects", () => {
		const original = {
			roomInfo: {
				roomId: "123",
				participantCount: 5,
			},
			participants: [
				{ displayName: "Alice", audioEnabled: true },
				{ displayName: "Bob", audioEnabled: false },
			],
		};

		const snaked = camelToSnake(original);
		const restored = snakeToCamel<typeof original>(snaked);

		expect(restored).toEqual(original);
	});
});
