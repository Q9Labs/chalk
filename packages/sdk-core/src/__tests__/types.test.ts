/**
 * Tests for Chalk SDK types
 * @module @q9labs/chalk-core/__tests__/types
 */

import { describe, expect, it } from "bun:test";
import {
	type ChalkError,
	ChalkErrorCode,
	type Err,
	err,
	type Ok,
	ok,
	type Result,
} from "../types.ts";

describe("Result Types", () => {
	describe("ok()", () => {
		it("should create a successful result", () => {
			const result = ok("success");

			expect(result.ok).toBe(true);
			expect(result.value).toBe("success");
		});

		it("should work with objects", () => {
			const data = { id: "123", name: "Test ConferenceSession" };
			const result = ok(data);

			expect(result.ok).toBe(true);
			expect(result.value).toEqual(data);
		});

		it("should be type-safe for Ok interface", () => {
			const result: Ok<string> = ok("test");
			expect(result.ok).toBe(true);
		});
	});

	describe("err()", () => {
		it("should create a failed result", () => {
			const error: ChalkError = {
				code: ChalkErrorCode.NETWORK_ERROR,
				message: "Network failed",
			};
			const result = err(error);

			expect(result.ok).toBe(false);
			expect(result.error).toEqual(error);
		});

		it("should be type-safe for Err interface", () => {
			const error: ChalkError = {
				code: ChalkErrorCode.UNAUTHORIZED,
				message: "Unauthorized",
			};
			const result: Err<ChalkError> = err(error);
			expect(result.ok).toBe(false);
		});

		it("should support custom error types", () => {
			const customError = { status: 401, message: "Auth failed" };
			const result = err(customError);

			expect(result.ok).toBe(false);
			expect(result.error).toEqual(customError);
		});
	});

	describe("Result type pattern matching", () => {
		it("should distinguish between Ok and Err with if statements", () => {
			const successResult: Result<string> = ok("success");
			const failureResult: Result<string> = err({
				code: ChalkErrorCode.NETWORK_ERROR,
				message: "Failed",
			});

			if (successResult.ok) {
				expect(successResult.value).toBe("success");
			}

			if (!failureResult.ok) {
				expect(failureResult.error.code).toBe(ChalkErrorCode.NETWORK_ERROR);
			}
		});

		it("should type-narrow correctly", () => {
			const result: Result<number> = ok(42);

			if (result.ok) {
				const num: number = result.value;
				expect(num).toBe(42);
			} else {
				const error: ChalkError = result.error;
				expect(error).toBeDefined();
			}
		});
	});
});

describe("ChalkErrorCode", () => {
	describe("Error codes structure", () => {
		it("should have network error codes", () => {
			expect(ChalkErrorCode.NETWORK_ERROR).toBe("NETWORK_ERROR");
			expect(ChalkErrorCode.CONNECTION_FAILED).toBe("CONNECTION_FAILED");
			expect(ChalkErrorCode.CONNECTION_LOST).toBe("CONNECTION_LOST");
			expect(ChalkErrorCode.MAX_RECONNECT_ATTEMPTS).toBe(
				"MAX_RECONNECT_ATTEMPTS",
			);
			expect(ChalkErrorCode.WS_ERROR).toBe("WS_ERROR");
		});

		it("should have auth error codes", () => {
			expect(ChalkErrorCode.UNAUTHORIZED).toBe("UNAUTHORIZED");
			expect(ChalkErrorCode.FORBIDDEN).toBe("FORBIDDEN");
			expect(ChalkErrorCode.TOKEN_EXPIRED).toBe("TOKEN_EXPIRED");
			expect(ChalkErrorCode.INVALID_API_KEY).toBe("INVALID_API_KEY");
		});

		it("should have room error codes", () => {
			expect(ChalkErrorCode.ROOM_NOT_FOUND).toBe("ROOM_NOT_FOUND");
			expect(ChalkErrorCode.ROOM_FULL).toBe("ROOM_FULL");
			expect(ChalkErrorCode.ROOM_ENDED).toBe("ROOM_ENDED");
			expect(ChalkErrorCode.NOT_IN_ROOM).toBe("NOT_IN_ROOM");
		});

		it("should have media error codes", () => {
			expect(ChalkErrorCode.MEDIA_ERROR).toBe("MEDIA_ERROR");
			expect(ChalkErrorCode.CAMERA_ACCESS_DENIED).toBe("CAMERA_ACCESS_DENIED");
			expect(ChalkErrorCode.MICROPHONE_ACCESS_DENIED).toBe(
				"MICROPHONE_ACCESS_DENIED",
			);
			expect(ChalkErrorCode.DEVICE_NOT_FOUND).toBe("DEVICE_NOT_FOUND");
			expect(ChalkErrorCode.SCREEN_SHARE_ERROR).toBe("SCREEN_SHARE_ERROR");
			expect(ChalkErrorCode.SCREEN_SHARE_CANCELLED).toBe(
				"SCREEN_SHARE_CANCELLED",
			);
		});

		it("should have recording error codes", () => {
			expect(ChalkErrorCode.RECORDING_FAILED).toBe("RECORDING_FAILED");
			expect(ChalkErrorCode.RECORDING_NOT_FOUND).toBe("RECORDING_NOT_FOUND");
		});

		it("should have general error codes", () => {
			expect(ChalkErrorCode.UNKNOWN_ERROR).toBe("UNKNOWN_ERROR");
			expect(ChalkErrorCode.INVALID_REQUEST).toBe("INVALID_REQUEST");
			expect(ChalkErrorCode.RATE_LIMITED).toBe("RATE_LIMITED");
		});
	});

	describe("Error code type safety", () => {
		it("should be assignable to ChalkErrorCode type", () => {
			const code: (typeof ChalkErrorCode)[keyof typeof ChalkErrorCode] =
				ChalkErrorCode.CAMERA_ACCESS_DENIED;
			expect(code).toBe("CAMERA_ACCESS_DENIED");
		});

		it("should work with error objects", () => {
			const error: ChalkError = {
				code: ChalkErrorCode.ROOM_NOT_FOUND,
				message: "ConferenceSession does not exist",
				details: { roomId: "room_123" },
			};

			expect(error.code).toBe(ChalkErrorCode.ROOM_NOT_FOUND);
			expect(error.message).toBe("ConferenceSession does not exist");
			expect(error.details?.roomId).toBe("room_123");
		});
	});
});

describe("ChalkError interface", () => {
	it("should create error with code and message", () => {
		const error: ChalkError = {
			code: ChalkErrorCode.CAMERA_ACCESS_DENIED,
			message: "Camera access was denied by user",
		};

		expect(error.code).toBe(ChalkErrorCode.CAMERA_ACCESS_DENIED);
		expect(error.message).toBe("Camera access was denied by user");
		expect(error.details).toBeUndefined();
	});

	it("should support additional details", () => {
		const error: ChalkError = {
			code: ChalkErrorCode.DEVICE_NOT_FOUND,
			message: "Camera device not found",
			details: {
				deviceId: "device_123",
				availableDevices: ["device_456", "device_789"],
			},
		};

		expect(error.details?.deviceId).toBe("device_123");
		expect(error.details?.availableDevices).toEqual([
			"device_456",
			"device_789",
		]);
	});

	it("should support custom error codes", () => {
		const customError: ChalkError = {
			code: "CUSTOM_ERROR",
			message: "Custom error message",
		};

		expect(customError.code).toBe("CUSTOM_ERROR");
	});
});
