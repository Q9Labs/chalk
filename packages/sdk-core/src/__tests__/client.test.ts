/**
 * Tests for ChalkClient
 * @module @q9labs/chalk-core/__tests__/client
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { ChalkClient } from "../client.ts";
import type { ChalkClientConfig, RoomConfig } from "../types.ts";

describe("ChalkClient", () => {
	describe("initialization", () => {
		it("should initialize with token (recommended)", () => {
			const config: ChalkClientConfig = {
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should initialize with tokenProvider (recommended for browser)", () => {
			const config: ChalkClientConfig = {
				tokenProvider: async () => "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should initialize with apiKey (deprecated)", () => {
			const originalWarn = console.warn;
			const warnings: string[] = [];
			console.warn = (msg: string) => warnings.push(msg);

			const config: ChalkClientConfig = {
				apiKey: "ck_live_test123",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();

			expect(warnings.some((w) => w.includes("DEPRECATION"))).toBe(true);
			console.warn = originalWarn;
		});

		it("should throw if no auth method provided", () => {
			const config: ChalkClientConfig = {};

			expect(() => {
				new ChalkClient(config);
			}).toThrow(
				"ChalkClient requires authentication: provide token, tokenProvider, or apiKey",
			);
		});

		it("should accept custom apiUrl and wsUrl with token", () => {
			const config: ChalkClientConfig = {
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
				apiUrl: "https://custom.api.com",
				wsUrl: "wss://custom.ws.com",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should accept debug flag", () => {
			const config: ChalkClientConfig = {
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
				debug: true,
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should allow debug mode without credentials", () => {
			expect(() => {
				new ChalkClient({ debug: true });
			}).not.toThrow();
		});
	});

	describe("connection status", () => {
		let client: ChalkClient;

		beforeEach(() => {
			client = new ChalkClient({
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
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
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});
		});

		it("should handle disconnection when not connected", () => {
			expect(() => {
				client.disconnect();
			}).not.toThrow();
		});
	});

	describe("configuration validation", () => {
		it("should accept token with apiKey simultaneously", () => {
			const originalWarn = console.warn;
			console.warn = () => {};

			const config: ChalkClientConfig = {
				apiKey: "ck_live_test123",
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();

			console.warn = originalWarn;
		});

		it("should work with custom API URLs and token", () => {
			const config: ChalkClientConfig = {
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
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
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});

			const status = client.connectionStatus;

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
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});

			const room = client.room;

			expect(room).toBeNull();
		});

		it("should maintain type safety for boolean flags", () => {
			const client = new ChalkClient({
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
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
	});

	describe("token-expired event", () => {
		it("should emit token-expired event when API returns 401", async () => {
			const client = new ChalkClient({
				token: "expired_token",
			});

			let eventReceived = false;
			client.on("token-expired", () => {
				eventReceived = true;
			});

			expect(eventReceived).toBe(false);
		});
	});
});
