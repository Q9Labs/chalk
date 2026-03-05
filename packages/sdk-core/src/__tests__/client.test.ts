/**
 * Tests for ConferenceClient
 * @module @q9labs/chalk-core/__tests__/client
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { ConferenceClient } from "../client.ts";
import { TimeoutError } from "../effect/errors.ts";
import type { ConferenceClientConfig, JoinSessionConfig } from "../types.ts";

describe("ConferenceClient", () => {
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
	const captureGlobal = (key: "window" | "document" | "navigator") => ({
		exists: key in globalThis,
		value: (globalThis as any)[key],
	});
	const restoreGlobal = (
		key: "window" | "document" | "navigator",
		snapshot: { exists: boolean; value: unknown },
	) => {
		if (snapshot.exists) {
			Object.defineProperty(globalThis, key, {
				value: snapshot.value,
				configurable: true,
				writable: true,
			});
			return;
		}
		delete (globalThis as any)[key];
	};
	const withBrowserNetworkEnv = async (
		connection: { effectiveType?: string; saveData?: boolean },
		run: () => Promise<void>,
	) => {
		const windowSnapshot = captureGlobal("window");
		const documentSnapshot = captureGlobal("document");
		const navigatorSnapshot = captureGlobal("navigator");

		Object.defineProperty(globalThis, "window", {
			value: {},
			configurable: true,
			writable: true,
		});
		Object.defineProperty(globalThis, "document", {
			value: {},
			configurable: true,
			writable: true,
		});
		Object.defineProperty(globalThis, "navigator", {
			value: { ...(navigatorSnapshot.value as object), connection },
			configurable: true,
			writable: true,
		});

		try {
			await run();
		} finally {
			restoreGlobal("window", windowSnapshot);
			restoreGlobal("document", documentSnapshot);
			restoreGlobal("navigator", navigatorSnapshot);
		}
	};
	const withNodeLikeEnv = async (run: () => Promise<void>) => {
		const windowSnapshot = captureGlobal("window");
		const documentSnapshot = captureGlobal("document");

		delete (globalThis as any).window;
		delete (globalThis as any).document;

		try {
			await run();
		} finally {
			restoreGlobal("window", windowSnapshot);
			restoreGlobal("document", documentSnapshot);
		}
	};

	describe("initialization", () => {
		it("should initialize with token (recommended)", () => {
			const config: ConferenceClientConfig = {
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			};

			expect(() => {
				new ConferenceClient(config);
			}).not.toThrow();
		});

		it("should initialize with tokenProvider (recommended for browser)", () => {
			const config: ConferenceClientConfig = {
				apiUrl: DEFAULT_API_URL,
				tokenProvider: async () => "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			};

			expect(() => {
				new ConferenceClient(config);
			}).not.toThrow();
		});

		it("should initialize with apiKey (deprecated)", () => {
			const originalWarn = console.warn;
			const warnings: string[] = [];
			console.warn = (msg: string) => warnings.push(msg);

			const config: ConferenceClientConfig = {
				apiUrl: DEFAULT_API_URL,
				apiKey: "ck_live_test123",
			};

			expect(() => {
				new ConferenceClient(config);
			}).not.toThrow();

			expect(warnings.some((w) => w.includes("DEPRECATION"))).toBe(true);
			console.warn = originalWarn;
		});

		it("should throw if no auth method provided", () => {
			const config: ConferenceClientConfig = { apiUrl: DEFAULT_API_URL };

			expect(() => {
				new ConferenceClient(config);
			}).toThrow(
				"ConferenceClient requires authentication: provide token, tokenProvider, or apiKey",
			);
		});

		it("should accept custom apiUrl and wsUrl with token", () => {
			const config: ConferenceClientConfig = {
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
				apiUrl: "https://custom.api.com",
				wsUrl: "wss://custom.ws.com",
			};

			expect(() => {
				new ConferenceClient(config);
			}).not.toThrow();
		});

		it("should accept debug flag", () => {
			const config: ConferenceClientConfig = {
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
				debug: true,
			};

			expect(() => {
				new ConferenceClient(config);
			}).not.toThrow();
		});

		it("should allow debug mode without credentials", () => {
			expect(() => {
				new ConferenceClient({ apiUrl: DEFAULT_API_URL, debug: true });
			}).not.toThrow();
		});
	});

	describe("connection status", () => {
		let client: ConferenceClient;

		beforeEach(() => {
			client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});
		});

		it("should start disconnected", () => {
			expect(client.isConnected).toBe(false);
			expect(client.connectionState).toBe("disconnected");
		});

		it("should return null room initially", () => {
			expect(client.room).toBeNull();
		});
	});

	describe("disconnect()", () => {
		let client: ConferenceClient;

		beforeEach(() => {
			client = new ConferenceClient({
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

			const config: ConferenceClientConfig = {
				apiUrl: DEFAULT_API_URL,
				apiKey: "ck_live_test123",
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			};

			expect(() => {
				new ConferenceClient(config);
			}).not.toThrow();

			console.warn = originalWarn;
		});

		it("should work with custom API URLs and token", () => {
			const config: ConferenceClientConfig = {
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
				apiUrl: "http://localhost:3000",
				wsUrl: "ws://localhost:3000/ws",
				debug: true,
			};

			expect(() => {
				new ConferenceClient(config);
			}).not.toThrow();
		});
	});

	describe("JoinSessionConfig type checking", () => {
		it("should have valid room config structure", () => {
			const config: JoinSessionConfig = {
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
			const config: JoinSessionConfig = {
				displayName: "Jane Doe",
			};

			expect(config.displayName).toBe("Jane Doe");
			expect(config.audio).toBeUndefined();
			expect(config.video).toBeUndefined();
		});

		it("should allow custom metadata", () => {
			const config: JoinSessionConfig = {
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
					new ConferenceClient(config as ConferenceClientConfig);
				}).toThrow();
			});

			// Debug mode without credentials should NOT throw (intentional)
			expect(() => {
				new ConferenceClient({ apiUrl: DEFAULT_API_URL, debug: true });
			}).not.toThrow();
		});
	});

	describe("type safety", () => {
		it("should maintain type safety for connection status", () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});

			const status = client.connectionState;

			type SessionConnectionState =
				| "connecting"
				| "connected"
				| "reconnecting"
				| "disconnected"
				| "failed";
			const _check: SessionConnectionState = status;
			expect(_check).toBeDefined();
		});

		it("should maintain type safety for room reference", () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});

			const room = client.room;

			expect(room).toBeNull();
		});

		it("should maintain type safety for boolean flags", () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
			});

			const isConnected: boolean = client.isConnected;
			expect(typeof isConnected).toBe("boolean");
		});
	});

	describe("config validation for room joining", () => {
		it("should require displayName in JoinSessionConfig", () => {
			const config: JoinSessionConfig = {
				displayName: "Test User",
			};

			expect(config.displayName).toBeDefined();
			expect(typeof config.displayName).toBe("string");
		});

		it("should allow audio and video booleans", () => {
			const config: JoinSessionConfig = {
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
			const client = new ConferenceClient({
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
			const client = new ConferenceClient({
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

	describe("realtimekit preload", () => {
		it("reuses preloaded RTK module for join initialization", async () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				token: "chalk_access_token",
			});
			const init = mock(async () => createMockRtkClient() as any);
			const importRealtimeKitClient = mock(async () => ({ init }));
			(client as any)._importRealtimeKitClient = importRealtimeKitClient;

			const preloaded = await client.preloadRealtimeKit();
			expect(preloaded).toBe(true);

			await Effect.runPromise(
				(client as any)._initRealtimeKitEffect("rtk_token", true, false),
			);

			expect(importRealtimeKitClient).toHaveBeenCalledTimes(1);
			expect(init).toHaveBeenCalledTimes(1);
			expect(init).toHaveBeenCalledWith({
				authToken: "rtk_token",
				defaults: {
					audio: true,
					video: false,
				},
			});
		});

		it("keeps preload safe and retries RTK import during join init after failure", async () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				token: "chalk_access_token",
			});
			const init = mock(async () => createMockRtkClient() as any);
			let shouldFailFirstImport = true;
			const importRealtimeKitClient = mock(async () => {
				if (shouldFailFirstImport) {
					shouldFailFirstImport = false;
					throw new Error("chunk load failed");
				}
				return { init };
			});
			(client as any)._importRealtimeKitClient = importRealtimeKitClient;

			const preloaded = await client.preloadRealtimeKit();
			expect(preloaded).toBe(false);

			await Effect.runPromise(
				(client as any)._initRealtimeKitEffect("rtk_token", false, false),
			);

			expect(importRealtimeKitClient).toHaveBeenCalledTimes(2);
			expect(init).toHaveBeenCalledTimes(1);
		});
	});

	describe("room joining resilience", () => {
		it("does not replace rtcToken with tokenProvider output when rtc token looks expired", async () => {
			const tokenProvider = mock(async () => "api_access_jwt_from_provider");
			const client = new ConferenceClient({
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
							name: "ConferenceSession 1",
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

			await client.joinSession("room_1", { displayName: "Alice" });

			expect(usedAuthToken).toBe(staleRtcToken);
			expect(tokenProvider).not.toHaveBeenCalled();
		});

		it("fails early when API response does not include rtcToken", async () => {
			const client = new ConferenceClient({
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
							name: "ConferenceSession 1",
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
				client.joinSession("room_1", { displayName: "Alice" }),
			).rejects.toThrow("RealtimeKit token missing - API did not return rtcToken");
		});

		it("tracks API latency in room.join phase timings", async () => {
			const wideEventsReceived: Array<{
				eventType: string;
				outcome: string;
				phases?: Record<string, number>;
			}> = [];
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				token: "chalk_access_token",
				wideEvents: {
					handler: (event) => {
						wideEventsReceived.push({
							eventType: event.eventType,
							outcome: event.outcome,
							phases: event.phases,
						});
					},
				},
			});
			(client as any).apiClient = {
				addParticipant: mock(
					() =>
						new Promise((resolve) => {
							setTimeout(() => {
								resolve({
									success: true,
									data: {
										participantId: "p_1",
										role: "participant",
										tokens: {
											rtcToken: createJwt({
												exp: Math.floor(Date.now() / 1000) + 60 * 5,
												scope: "rtk",
											}),
											accessToken: "chalk_access_token",
										},
										room: {
											id: "room_1",
											name: "ConferenceSession 1",
											status: "active",
											participantCount: 1,
											config: {},
											createdAt: new Date(),
										},
									},
								});
							}, 25);
						}),
				),
				setToken: mock(() => {}),
			};
			(client as any)._initRealtimeKitEffect = () =>
				Effect.succeed(createMockRtkClient() as any);
			(client as any)._joinRealtimeKitWithRetry = mock(async () => {});

			await client.joinSession("room_1", { displayName: "Alice" });

			const joinEvent = wideEventsReceived.find((event) => event.eventType === "room.join");
			expect(joinEvent).toBeDefined();
			expect(joinEvent?.outcome).toBe("success");
			expect(joinEvent?.phases?.api).toBeGreaterThanOrEqual(15);
		});

		it("uses default RTK join policy for non-browser cohort", async () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "chalk_access_token",
			});
			const join = mock(async () => {});
			const timeoutSamples: number[] = [];
			(client as any)._joinRealtimeKitEffect = mock(
				(_joinPromise: Promise<void>, timeoutMs: number) => {
					timeoutSamples.push(timeoutMs);
					return Effect.fail(new Error("join attempt failed"));
				},
			);
			const scheduledDelays: number[] = [];
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
				scheduledDelays.push(typeof delay === "number" ? delay : 0);
				if (typeof handler === "function") handler();
				return 0 as any;
			}) as any;

			try {
				await withNodeLikeEnv(async () => {
					await expect(
						(client as any)._joinRealtimeKitWithRetry({ join } as any),
					).rejects.toThrow("Failed to join room after 5 attempts: join attempt failed");
				});
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}

			expect(timeoutSamples).toEqual([30000, 30000, 30000, 30000, 30000]);
			expect(scheduledDelays).toEqual([500, 1000, 2000, 4000]);
		});

		it("uses degraded-network RTK join policy for constrained browser cohort", async () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "chalk_access_token",
			});
			const join = mock(async () => {});
			const timeoutSamples: number[] = [];
			(client as any)._joinRealtimeKitEffect = mock(
				(_joinPromise: Promise<void>, timeoutMs: number) => {
					timeoutSamples.push(timeoutMs);
					return Effect.fail(new Error("join attempt failed"));
				},
			);
			const scheduledDelays: number[] = [];
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
				scheduledDelays.push(typeof delay === "number" ? delay : 0);
				if (typeof handler === "function") handler();
				return 0 as any;
			}) as any;

			try {
				await withBrowserNetworkEnv(
					{ effectiveType: "2g", saveData: true },
					async () => {
						await expect(
							(client as any)._joinRealtimeKitWithRetry({ join } as any),
						).rejects.toThrow("Failed to join room after 5 attempts: join attempt failed");
					},
				);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}

			expect(timeoutSamples).toEqual([45000, 45000, 45000, 45000, 45000]);
			expect(scheduledDelays).toEqual([1000, 2000, 4000, 8000]);
		});

		it("emits RTK join cohort/policy in room.join wide-event data", async () => {
			const wideEventsReceived: Array<{
				eventType: string;
				outcome: string;
				data?: Record<string, unknown>;
			}> = [];
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				token: "chalk_access_token",
				wideEvents: {
					handler: (event) => {
						wideEventsReceived.push({
							eventType: event.eventType,
							outcome: event.outcome,
							data: event.data,
						});
					},
				},
			});
			(client as any).apiClient = {
				addParticipant: mock(async () => ({
					success: true,
					data: {
						participantId: "p_1",
						role: "participant",
						tokens: {
							rtcToken: createJwt({
								exp: Math.floor(Date.now() / 1000) + 60 * 5,
								scope: "rtk",
							}),
							accessToken: "chalk_access_token",
						},
						room: {
							id: "room_1",
							name: "ConferenceSession 1",
							status: "active",
							participantCount: 1,
							config: {},
							createdAt: new Date(),
						},
					},
				})),
				setToken: mock(() => {}),
			};
			(client as any)._initRealtimeKitEffect = () =>
				Effect.succeed(createMockRtkClient() as any);
			(client as any)._joinRealtimeKitWithRetry = mock(async () => {});

			await withBrowserNetworkEnv(
				{ effectiveType: "2g", saveData: true },
				async () => {
					await client.joinSession("room_1", { displayName: "Alice" });
				},
			);

			const joinEvent = wideEventsReceived.find((event) => event.eventType === "room.join");
			const rtkJoinPolicy = joinEvent?.data?.rtkJoinPolicy as
				| {
						cohort?: string;
						policy?: { name?: string; timeoutMs?: number; retryDelaysMs?: number[] };
				  }
				| undefined;

			expect(joinEvent?.outcome).toBe("success");
			expect(rtkJoinPolicy?.cohort).toBe("browser-2g-save-data");
			expect(rtkJoinPolicy?.policy?.name).toBe("degraded-network");
			expect(rtkJoinPolicy?.policy?.timeoutMs).toBe(45000);
			expect(rtkJoinPolicy?.policy?.retryDelaysMs).toEqual([1000, 2000, 4000, 8000]);
		});

		it("retries RTK join and succeeds on a later attempt", async () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "chalk_access_token",
			});
			const join = mock(async () => {});
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
				await (client as any)._joinRealtimeKitWithRetry({ join } as any);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}

			expect(joinEffect).toHaveBeenCalledTimes(3);
		});

		it("emits per-attempt RTK join telemetry with timeout/error classification", async () => {
			const wideEventsReceived: Array<{
				eventType: string;
				outcome: string;
				durationMs: number;
				data?: Record<string, unknown>;
			}> = [];
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "chalk_access_token",
				wideEvents: {
					handler: (event) => {
						wideEventsReceived.push({
							eventType: event.eventType,
							outcome: event.outcome,
							durationMs: event.durationMs,
							data: event.data,
						});
					},
				},
			});

			const join = mock(async () => {});
			const timeoutError = new TimeoutError({
				message: "ConferenceSession join timed out after 1000ms",
				operation: "joinRTKRoom",
				timeoutMs: 1000,
			});

			let attemptCount = 0;
			(client as any)._joinRealtimeKitEffect = mock(() => {
				attemptCount += 1;
				if (attemptCount === 1) {
					return Effect.fail(timeoutError);
				}
				if (attemptCount === 2) {
					return Effect.fail(new Error("socket closed"));
				}
				return Effect.succeed(undefined);
			});

			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((handler: TimerHandler) => {
				if (typeof handler === "function") handler();
				return 0 as any;
			}) as any;

			try {
				await (client as any)._joinRealtimeKitWithRetry(
					{ join } as any,
					{
						cohort: "test",
						policy: {
							name: "test-policy",
							timeoutMs: 1000,
							retryDelaysMs: [10, 20],
						},
					},
				);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}

			const attemptEvents = wideEventsReceived.filter(
				(event) => event.eventType === "room.join.rtk.attempt",
			);
			expect(attemptEvents).toHaveLength(3);
			expect(attemptEvents.map((event) => event.outcome)).toEqual([
				"timeout",
				"error",
				"success",
			]);
			expect(attemptEvents.map((event) => event.data?.attempt)).toEqual([1, 2, 3]);
			expect(attemptEvents.map((event) => event.data?.delayMs)).toEqual([10, 20, 0]);
			expect(attemptEvents.map((event) => event.data?.timeoutVsError)).toEqual([
				"timeout",
				"error",
				"none",
			]);
			expect(
				attemptEvents.every(
					(event) =>
						typeof event.data?.attemptDurationMs === "number" &&
						(event.data?.attemptDurationMs as number) >= 0 &&
						event.durationMs >= 0,
				),
			).toBe(true);
		});

		it("fails after max RTK join retry attempts", async () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "chalk_access_token",
			});
			const join = mock(async () => {});
			const joinEffect = mock(() => Effect.fail(new Error("socket closed")));
			(client as any)._joinRealtimeKitEffect = joinEffect;
			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((handler: TimerHandler) => {
				if (typeof handler === "function") handler();
				return 0 as any;
			}) as any;

			try {
				await expect(
					(client as any)._joinRealtimeKitWithRetry({ join } as any),
				).rejects.toThrow("Failed to join room after 5 attempts: socket closed");
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}

			expect(joinEffect).toHaveBeenCalledTimes(5);
		});

		it("does not duplicate join calls while an in-flight RTK join is timing out", async () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "chalk_access_token",
			});
			const join = mock(
				() => new Promise<void>(() => {
					// Keep unresolved to simulate an in-flight join.
				}),
			);
			const timeoutError = new TimeoutError({
				message: "ConferenceSession join timed out after 30000ms",
				operation: "joinRTKRoom",
				timeoutMs: 30000,
			});
			(client as any)._joinRealtimeKitEffect = mock(() =>
				Effect.fail(timeoutError),
			);

			const originalSetTimeout = globalThis.setTimeout;
			globalThis.setTimeout = ((handler: TimerHandler) => {
				if (typeof handler === "function") handler();
				return 0 as any;
			}) as any;

			try {
				await expect(
					(client as any)._joinRealtimeKitWithRetry({ join } as any),
				).rejects.toThrow("Failed to join room after 5 attempts");
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}

			expect(join).toHaveBeenCalledTimes(1);
		});
	});

	describe("posthog session replay integration", () => {
		const buildJoinSuccessResponse = () => ({
			success: true,
			data: {
				participantId: "p_1",
				role: "host",
				tokens: {
					rtcToken: createJwt({
						exp: Math.floor(Date.now() / 1000) + 60 * 5,
						scope: "rtk",
					}),
					accessToken: "chalk_access_token",
				},
				room: {
					id: "room_1",
					name: "ConferenceSession 1",
					status: "active",
					participantCount: 1,
					config: {},
					createdAt: new Date(),
				},
				roomCreated: false,
			},
		});

		it("starts replay and captures joined event on successful join", async () => {
			const posthog = {
				startSessionRecording: mock(() => {}),
				stopSessionRecording: mock(() => {}),
				capture: mock(() => {}),
			};
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				token: "chalk_access_token",
				posthog: { client: posthog },
			});
			(client as any).apiClient = {
				addParticipant: mock(async () => buildJoinSuccessResponse()),
				setToken: mock(() => {}),
			};
			(client as any)._initRealtimeKitEffect = () =>
				Effect.succeed(createMockRtkClient() as any);
			(client as any)._joinRealtimeKitWithRetry = mock(async () => {});

			await client.joinSession("room_1", { displayName: "Alice" });

			expect(posthog.startSessionRecording).toHaveBeenCalledTimes(1);
			expect(posthog.capture).toHaveBeenCalledWith(
				"chalk_sdk_session_joined",
				expect.objectContaining({
					roomId: "room_1",
					participantId: "p_1",
					displayName: "Alice",
					role: "host",
					demoMode: false,
				}),
			);
		});

		it("stops replay and captures left event on disconnect", async () => {
			const posthog = {
				startSessionRecording: mock(() => {}),
				stopSessionRecording: mock(() => {}),
				capture: mock(() => {}),
			};
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				token: "chalk_access_token",
				posthog: { client: posthog },
			});
			(client as any).apiClient = {
				addParticipant: mock(async () => buildJoinSuccessResponse()),
				setToken: mock(() => {}),
			};
			(client as any)._initRealtimeKitEffect = () =>
				Effect.succeed(createMockRtkClient() as any);
			(client as any)._joinRealtimeKitWithRetry = mock(async () => {});

			await client.joinSession("room_1", { displayName: "Alice" });
			client.disconnect();

			expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(1);
			expect(posthog.capture).toHaveBeenCalledWith(
				"chalk_sdk_session_left",
				expect.objectContaining({
					roomId: "room_1",
					participantId: "p_1",
					reason: "disconnect",
					demoMode: false,
				}),
			);
		});

		it("captures join failures for replay triage", async () => {
			const posthog = {
				startSessionRecording: mock(() => {}),
				stopSessionRecording: mock(() => {}),
				capture: mock(() => {}),
			};
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				token: "chalk_access_token",
				posthog: { client: posthog },
			});
			(client as any).apiClient = {
				addParticipant: mock(async () => ({
					success: false,
					error: { message: "join api failed" },
				})),
				setToken: mock(() => {}),
			};

			await expect(
				client.joinSession("room_1", { displayName: "Alice" }),
			).rejects.toThrow("join api failed");

			expect(posthog.startSessionRecording).not.toHaveBeenCalled();
			expect(posthog.capture).toHaveBeenCalledWith(
				"chalk_sdk_session_join_failed",
				expect.objectContaining({
					roomId: "room_1",
					displayName: "Alice",
					error: "join api failed",
					demoMode: false,
				}),
			);
		});

		it("does not fail join/leave when posthog methods throw", async () => {
			const posthog = {
				startSessionRecording: mock(() => {
					throw new Error("posthog start failed");
				}),
				stopSessionRecording: mock(() => {
					throw new Error("posthog stop failed");
				}),
				capture: mock(() => {
					throw new Error("posthog capture failed");
				}),
			};
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				wsUrl: "",
				token: "chalk_access_token",
				posthog: { client: posthog },
			});
			(client as any).apiClient = {
				addParticipant: mock(async () => buildJoinSuccessResponse()),
				setToken: mock(() => {}),
			};
			(client as any)._initRealtimeKitEffect = () =>
				Effect.succeed(createMockRtkClient() as any);
			(client as any)._joinRealtimeKitWithRetry = mock(async () => {});

			await expect(
				client.joinSession("room_1", { displayName: "Alice" }),
			).resolves.toBeDefined();
			expect(() => client.disconnect()).not.toThrow();
		});
	});

	describe("token.expired event", () => {
		it("forwards token.expired from APIClient", () => {
			const client = new ConferenceClient({
				apiUrl: DEFAULT_API_URL,
				token: "expired_token",
			});

			const error = { code: "TOKEN_EXPIRED", message: "token expired" };
			let received: typeof error | null = null;
			client.on("token.expired", (payload) => {
				received = payload;
			});
			(client as any).apiClient.emit("token.expired", error);

			expect(received).toEqual(error);
		});
	});
});
