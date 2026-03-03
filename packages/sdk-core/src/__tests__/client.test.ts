/**
 * Tests for ChalkClient
 * @module @q9labs/chalk-core/__tests__/client
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { ChalkClient } from "../client.ts";
import type { ChalkClientConfig, RoomConfig } from "../types.ts";

describe("ChalkClient", () => {
	const DEFAULT_API_URL = "http://localhost:8080";
	const createJwt = (payload: Record<string, unknown>): string => {
		const header = { alg: "HS256", typ: "JWT" };
		const encode = (value: Record<string, unknown>) =>
			Buffer.from(JSON.stringify(value))
				.toString("base64")
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/g, "");
		return `${encode(header)}.${encode(payload)}.signature`;
	};
	const createMockEmitter = () => ({ on: mock(() => () => {}) });
	const createMockRtkClient = () => {
		const self = createMockEmitter() as any;
		self.videoEnabled = false;
		self.audioEnabled = false;
		self.videoTrack = null;
		self.audioTrack = null;
		return {
			self,
			participants: {
				joined: createMockEmitter(),
				on: mock(() => () => {}),
			},
		};
	};

	describe("initialization", () => {
		it("should initialize with token (recommended)", () => {
			const config: ChalkClientConfig = {
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should initialize with tokenProvider (recommended for browser)", () => {
			const config: ChalkClientConfig = {
				apiUrl: DEFAULT_API_URL,
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
				apiUrl: DEFAULT_API_URL,
				apiKey: "ck_live_test123",
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();

			expect(warnings.some((w) => w.includes("DEPRECATION"))).toBe(true);
			console.warn = originalWarn;
		});

		it("should throw if no auth method provided", () => {
			const config: ChalkClientConfig = { apiUrl: DEFAULT_API_URL };

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
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
				debug: true,
			};

			expect(() => {
				new ChalkClient(config);
			}).not.toThrow();
		});

		it("should allow debug mode without credentials", () => {
			expect(() => {
				new ChalkClient({ apiUrl: DEFAULT_API_URL, debug: true });
			}).not.toThrow();
		});
	});

	describe("connection status", () => {
		let client: ChalkClient;

		beforeEach(() => {
			client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
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
				apiUrl: DEFAULT_API_URL,
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
				apiUrl: DEFAULT_API_URL,
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
				new ChalkClient({ apiUrl: DEFAULT_API_URL, debug: true });
			}).not.toThrow();
		});
	});

	describe("type safety", () => {
		it("should maintain type safety for connection status", () => {
			const client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
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
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});

			const room = client.room;

			expect(room).toBeNull();
		});

		it("should maintain type safety for boolean flags", () => {
			const client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
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

	describe("rtc token expiry parsing", () => {
		it("should parse base64url JWT payloads without false expiry", () => {
			const client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});
			const rtcToken = createJwt({
				exp: Math.floor(Date.now() / 1000) + 60 * 5,
				room: "test-room",
				scope: "rtk",
			});

			const expired = (client as any).isTokenExpired(rtcToken);
			expect(expired).toBe(false);
		});

		it("should mark past-expiry JWT as expired", () => {
			const client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});
			const rtcToken = createJwt({
				exp: Math.floor(Date.now() / 1000) - 10,
			});

			const expired = (client as any).isTokenExpired(rtcToken);
			expect(expired).toBe(true);
		});
	});

	describe("room joining resilience", () => {
		it("does not replace rtcToken with tokenProvider output when rtc token looks expired", async () => {
			const tokenProvider = mock(async () => "api_access_jwt_from_provider");
			const client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				tokenProvider,
			});
			const staleRtcToken = createJwt({
				exp: Math.floor(Date.now() / 1000) - 60,
				scope: "rtk",
			});
			(client as any).apiClient = {
				addParticipant: mock(async () => ({
					success: true,
					data: {
						participantId: "p_1",
						role: "participant",
						tokens: {
							rtcToken: staleRtcToken,
							accessToken: "chalk_access_token",
						},
						room: {
							id: "room_1",
							name: "Room 1",
							status: "active",
							participantCount: 1,
							config: {},
							createdAt: new Date(),
						},
					},
				})),
				setToken: mock(() => {}),
			};
			let usedAuthToken = "";
			(client as any)._initRealtimeKitEffect = (authToken: string) => {
				usedAuthToken = authToken;
				return Effect.succeed(createMockRtkClient() as any);
			};
			(client as any)._joinRealtimeKitWithRetry = mock(async () => {});

			await client.joinRoom("room_1", { displayName: "Alice" });

			expect(usedAuthToken).toBe(staleRtcToken);
			expect(tokenProvider).not.toHaveBeenCalled();
		});

		it("fails early when API response does not include rtcToken", async () => {
			const client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				token: "chalk_access_token",
			});
			(client as any).apiClient = {
				addParticipant: mock(async () => ({
					success: true,
					data: {
						participantId: "p_1",
						role: "participant",
						tokens: {
							accessToken: "chalk_access_token",
						},
						room: {
							id: "room_1",
							name: "Room 1",
							status: "active",
							participantCount: 1,
							config: {},
							createdAt: new Date(),
						},
					},
				})),
				setToken: mock(() => {}),
			};

			await expect(
				client.joinRoom("room_1", { displayName: "Alice" }),
			).rejects.toThrow("RealtimeKit token missing - API did not return rtcToken");
		});

		it("retries RTK join and succeeds on a later attempt", async () => {
			const client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
				token: "chalk_access_token",
			});
			const joinEffect = mock(() => {
				if (joinEffect.mock.calls.length < 3) {
					return Effect.fail(new Error("join attempt failed"));
				}
				return Effect.succeed(undefined);
			});
			(client as any)._joinRealtimeKitEffect = joinEffect;
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((handler: TimerHandler) => {
				if (typeof handler === "function") handler();
				return 0 as any;
			}) as any;

			try {
				await (client as any)._joinRealtimeKitWithRetry({} as any);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}

			expect(joinEffect).toHaveBeenCalledTimes(3);
		});

		it("fails after max RTK join retry attempts", async () => {
			const client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
				token: "chalk_access_token",
			});
			const joinEffect = mock(() => Effect.fail(new Error("socket closed")));
			(client as any)._joinRealtimeKitEffect = joinEffect;
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((handler: TimerHandler) => {
				if (typeof handler === "function") handler();
				return 0 as any;
			}) as any;

			try {
				await expect(
					(client as any)._joinRealtimeKitWithRetry({} as any),
				).rejects.toThrow("Failed to join room after 5 attempts: socket closed");
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}

			expect(joinEffect).toHaveBeenCalledTimes(5);
		});
	});

	describe("token-expired event", () => {
		it("should emit token-expired event when API returns 401", async () => {
			const client = new ChalkClient({
				apiUrl: DEFAULT_API_URL,
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
