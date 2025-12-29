/**
 * Tests for ChalkClient
 * @module @chalk/core/__tests__/client
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ChalkClient } from "../client.ts";
import type { ChalkClientConfig, RoomConfig } from "../types.ts";

describe("ChalkClient", () => {
	describe("initialization", () => {
		it("should initialize with apiKey", () => {
			const config: ChalkClientConfig = {
				apiKey: "ck_live_test123",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should initialize with token", () => {
			const config: ChalkClientConfig = {
				token: "eyJhbGc...",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should throw if neither apiKey nor token provided", () => {
			const config: ChalkClientConfig = {};

			expect(() => {
				new ChalkClient(config);
			}).toThrow("ChalkClient requires either apiKey or token");
		});

		it("should accept custom apiUrl and wsUrl", () => {
			const config: ChalkClientConfig = {
				apiKey: "ck_live_test123",
				apiUrl: "https://custom.api.com",
				wsUrl: "wss://custom.ws.com",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should accept debug flag", () => {
			const config: ChalkClientConfig = {
				apiKey: "ck_live_test123",
				debug: true,
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});
	});

	describe("connection status", () => {
		let client: ChalkClient;

		beforeEach(() => {
			client = new ChalkClient({
				apiKey: "ck_live_test123",
			});
		});

		it("should start disconnected", () => {
			expect(client.isConnected).toBe(false);
			expect(client.connectionStatus).toBe("disconnected");
		});

		it("should return null room initially", () => {
			expect(client.room).toBeNull();
		});
	});

	describe("disconnect()", () => {
		let client: ChalkClient;

		beforeEach(() => {
			client = new ChalkClient({
				apiKey: "ck_live_test123",
			});
		});

		it("should handle disconnection when not connected", () => {
			expect(() => {
				client.disconnect();
			}).not.toThrow();
		});
	});

	describe("configuration validation", () => {
		it("should accept both apiKey and token simultaneously", () => {
			const config: ChalkClientConfig = {
				apiKey: "ck_live_test123",
				token: "eyJhbGc...",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should work with custom API URLs", () => {
			const config: ChalkClientConfig = {
				apiKey: "ck_live_test123",
				apiUrl: "http://localhost:3000",
				wsUrl: "ws://localhost:3000/ws",
				debug: true,
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});
	});

	describe("RoomConfig type checking", () => {
		it("should have valid room config structure", () => {
			const config: RoomConfig = {
				displayName: "John Doe",
				audio: true,
				video: false,
				metadata: {
					role: "teacher",
					grade: "A",
				},
			};

			expect(config.displayName).toBe("John Doe");
			expect(config.audio).toBe(true);
			expect(config.video).toBe(false);
			expect(config.metadata?.role).toBe("teacher");
		});

		it("should support minimal room config", () => {
			const config: RoomConfig = {
				displayName: "Jane Doe",
			};

			expect(config.displayName).toBe("Jane Doe");
			expect(config.audio).toBeUndefined();
			expect(config.video).toBeUndefined();
		});

		it("should allow custom metadata", () => {
			const config: RoomConfig = {
				displayName: "Alice",
				metadata: {
					customField: "customValue",
					nested: {
						data: 123,
					},
				},
			};

			expect(config.metadata?.customField).toBe("customValue");
			expect(config.metadata?.nested).toEqual({ data: 123 });
		});
	});

	describe("error handling", () => {
		it("should handle missing configuration gracefully", () => {
			// These configs should throw (no apiKey, token, or debug mode)
			const invalidConfigs = [
				{},
				{ apiUrl: "https://api.example.com" },
				{ wsUrl: "wss://ws.example.com" },
			];

			invalidConfigs.forEach((config) => {
				expect(() => {
					new ChalkClient(config as ChalkClientConfig);
				}).toThrow();
			});

			// Debug mode without credentials should NOT throw (intentional)
			expect(() => {
				new ChalkClient({ debug: true });
			}).not.toThrow();
		});
	});

	describe("type safety", () => {
		it("should maintain type safety for connection status", () => {
			const client = new ChalkClient({
				apiKey: "ck_live_test123",
			});

			const status = client.connectionStatus;

			// status should be assignable to RoomStatus type
			type RoomStatus =
				| "connecting"
				| "connected"
				| "reconnecting"
				| "disconnected"
				| "failed";
			const _check: RoomStatus = status;
			expect(_check).toBeDefined();
		});

		it("should maintain type safety for room reference", () => {
			const client = new ChalkClient({
				apiKey: "ck_live_test123",
			});

			const room = client.room;

			expect(room).toBeNull();
		});

		it("should maintain type safety for boolean flags", () => {
			const client = new ChalkClient({
				apiKey: "ck_live_test123",
			});

			const isConnected: boolean = client.isConnected;
			expect(typeof isConnected).toBe("boolean");
		});
	});

	describe("config validation for room joining", () => {
		it("should require displayName in RoomConfig", () => {
			const config: RoomConfig = {
				displayName: "Test User",
			};

			expect(config.displayName).toBeDefined();
			expect(typeof config.displayName).toBe("string");
		});

		it("should allow audio and video booleans", () => {
			const config: RoomConfig = {
				displayName: "Test User",
				audio: true,
				video: true,
			};

			expect(typeof config.audio).toBe("boolean");
			expect(typeof config.video).toBe("boolean");
		});

		it("should allow media constraints objects", () => {
			const config: RoomConfig = {
				displayName: "Test User",
				audio: true,
				video: { width: { ideal: 1280 }, height: { ideal: 720 } },
			};

			expect(config.video).toBeDefined();
		});
	});
});
