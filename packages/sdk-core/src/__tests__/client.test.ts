/**
 * Tests for ConferenceClient
 * @module @q9labs/chalk-core/__tests__/client
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ConferenceClient } from "../client.ts";
import { TimeoutError } from "../effect/errors.ts";
import type { ConferenceClientConfig, JoinSessionConfig } from "../types.ts";

describe("ConferenceClient", () => {
  const DEFAULT_API_URL = "http://localhost:8080";
  const createJwt = (payload: Record<string, unknown>): string => {
    const header = { alg: "HS256", typ: "JWT" };
    const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return `${encode(header)}.${encode(payload)}.signature`;
  };
  const createMockEmitter = () => ({ on: vi.fn(() => () => {}) });
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
        on: vi.fn(() => () => {}),
      },
    };
  };
  const captureGlobal = (key: "window" | "document" | "navigator") => ({
    exists: key in globalThis,
    value: (globalThis as any)[key],
  });
  const restoreGlobal = (key: "window" | "document" | "navigator", snapshot: { exists: boolean; value: unknown }) => {
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
  const withBrowserNetworkEnv = async (connection: { effectiveType?: string; saveData?: boolean }, run: () => Promise<void>) => {
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
      }).toThrow("ConferenceClient requires authentication: provide token, tokenProvider, or apiKey");
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

    it("should use a custom RealtimeKit loader when provided", async () => {
      let loadCount = 0;
      const client = new ConferenceClient({
        apiUrl: DEFAULT_API_URL,
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test",
        realtimeKitLoader: async () => {
          loadCount += 1;
          return {
            init: async () => createMockRtkClient() as any,
          };
        },
      });

      await expect(client.preloadRealtimeKit()).resolves.toBe(true);
      expect(loadCount).toBe(1);
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
      const invalidConfigs = [{}, { apiUrl: "https://api.example.com" }, { wsUrl: "wss://ws.example.com" }];

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

      type SessionConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected" | "failed";
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
    it("uses a custom RTK loader when provided", async () => {
      const init = vi.fn(async () => createMockRtkClient() as any);
      const customLoader = vi.fn(async () => ({ init }));
      const client = new ConferenceClient({
        apiUrl: DEFAULT_API_URL,
        wsUrl: "",
        token: "chalk_access_token",
        realtimeKitLoader: customLoader,
      });

      const preloaded = await client.preloadRealtimeKit();
      expect(preloaded).toBe(true);

      await Effect.runPromise((client as any)._initRealtimeKitEffect("rtk_token", true, false));

      expect(customLoader).toHaveBeenCalledTimes(1);
      expect(init).toHaveBeenCalledTimes(1);
    });

    it("reuses preloaded RTK module for join initialization", async () => {
      const client = new ConferenceClient({
        apiUrl: DEFAULT_API_URL,
        wsUrl: "",
        token: "chalk_access_token",
      });
      const init = vi.fn(async () => createMockRtkClient() as any);
      const importRealtimeKitClient = vi.fn(async () => ({ init }));
      (client as any)._importRealtimeKitClient = importRealtimeKitClient;

      const preloaded = await client.preloadRealtimeKit();
      expect(preloaded).toBe(true);

      await Effect.runPromise((client as any)._initRealtimeKitEffect("rtk_token", true, false));

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
      const init = vi.fn(async () => createMockRtkClient() as any);
      let shouldFailFirstImport = true;
      const importRealtimeKitClient = vi.fn(async () => {
        if (shouldFailFirstImport) {
          shouldFailFirstImport = false;
          throw new Error("chunk load failed");
        }
        return { init };
      });
      (client as any)._importRealtimeKitClient = importRealtimeKitClient;

      const preloaded = await client.preloadRealtimeKit();
      expect(preloaded).toBe(false);

      await Effect.runPromise((client as any)._initRealtimeKitEffect("rtk_token", false, false));

      expect(importRealtimeKitClient).toHaveBeenCalledTimes(2);
      expect(init).toHaveBeenCalledTimes(1);
    });
  });

  describe("room joining resilience", () => {
    it("marks room status connected after join even when no post-attach RTK roomJoined event fires", async () => {
      const client = new ConferenceClient({
        apiUrl: DEFAULT_API_URL,
        wsUrl: "",
        token: "chalk_access_token",
      });

      const mockRtkClient = createMockRtkClient() as any;
      (client as any).apiClient = {
        addParticipant: vi.fn(async () => ({
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
        setToken: vi.fn(() => {}),
      };
      (client as any)._initRealtimeKitEffect = () => Effect.succeed(mockRtkClient);
      (client as any)._joinRealtimeKitWithRetry = vi.fn(async (rtkClientFactory: () => Promise<any>) => rtkClientFactory());

      const room = await client.joinSession("room_1", { displayName: "Alice", audio: true, video: true });

      expect(room.status).toBe("connected");
      expect(client.connectionState).toBe("connected");
    });

    it("does not replace rtcToken with tokenProvider output when rtc token looks expired", async () => {
      const tokenProvider = vi.fn(async () => "api_access_jwt_from_provider");
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
        addParticipant: vi.fn(async () => ({
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
        setToken: vi.fn(() => {}),
      };
      let usedAuthToken = "";
      (client as any)._initRealtimeKitEffect = (authToken: string) => {
        usedAuthToken = authToken;
        return Effect.succeed(createMockRtkClient() as any);
      };
      (client as any)._joinRealtimeKitWithRetry = vi.fn(async (rtkClientFactory: () => Promise<any>) => rtkClientFactory());

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
        addParticipant: vi.fn(async () => ({
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
        setToken: vi.fn(() => {}),
      };

      await expect(client.joinSession("room_1", { displayName: "Alice" })).rejects.toThrow("RealtimeKit token missing - API did not return rtcToken");
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
        addParticipant: vi.fn(
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
        setToken: vi.fn(() => {}),
      };
      (client as any)._initRealtimeKitEffect = () => Effect.succeed(createMockRtkClient() as any);
      (client as any)._joinRealtimeKitWithRetry = vi.fn(async () => {});

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
      const join = vi.fn(async () => {});
      const timeoutSamples: number[] = [];
      (client as any)._joinRealtimeKitEffect = vi.fn((_joinPromise: Promise<void>, timeoutMs: number) => {
        timeoutSamples.push(timeoutMs);
        return Effect.fail(new Error("join attempt failed"));
      });
      const scheduledDelays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
        scheduledDelays.push(typeof delay === "number" ? delay : 0);
        if (typeof handler === "function") handler();
        return 0 as any;
      }) as any;

      try {
        await withNodeLikeEnv(async () => {
          await expect((client as any)._joinRealtimeKitWithRetry({ join } as any)).rejects.toThrow("Failed to join room after 5 attempts: join attempt failed");
        });
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }

      expect(timeoutSamples).toEqual([30000]);
      expect(scheduledDelays).toEqual([]);
    });

    it("uses degraded-network RTK join policy for constrained browser cohort", async () => {
      const client = new ConferenceClient({
        apiUrl: DEFAULT_API_URL,
        token: "chalk_access_token",
      });
      const join = vi.fn(async () => {});
      const timeoutSamples: number[] = [];
      (client as any)._joinRealtimeKitEffect = vi.fn((_joinPromise: Promise<void>, timeoutMs: number) => {
        timeoutSamples.push(timeoutMs);
        return Effect.fail(new Error("join attempt failed"));
      });
      const scheduledDelays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
        scheduledDelays.push(typeof delay === "number" ? delay : 0);
        if (typeof handler === "function") handler();
        return 0 as any;
      }) as any;

      try {
        await withBrowserNetworkEnv({ effectiveType: "2g", saveData: true }, async () => {
          await expect((client as any)._joinRealtimeKitWithRetry({ join } as any)).rejects.toThrow("Failed to join room after 5 attempts: join attempt failed");
        });
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }

      expect(timeoutSamples).toEqual([45000]);
      expect(scheduledDelays).toEqual([]);
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
        addParticipant: vi.fn(async () => ({
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
        setToken: vi.fn(() => {}),
      };
      (client as any)._initRealtimeKitEffect = () => Effect.succeed(createMockRtkClient() as any);
      (client as any)._joinRealtimeKitWithRetry = vi.fn(async () => {});

      await withBrowserNetworkEnv({ effectiveType: "2g", saveData: true }, async () => {
        await client.joinSession("room_1", { displayName: "Alice" });
      });

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
      const join = vi.fn(async () => {});
      const joinEffect = vi.fn(() => {
        if (joinEffect.mock.calls.length < 3) {
          return Effect.fail(
            new TimeoutError({
              message: "ConferenceSession join timed out after 30000ms",
              operation: "joinRTKRoom",
              timeoutMs: 30000,
            }),
          );
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

    it("emits per-attempt RTK join telemetry across timeout retries", async () => {
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

      const join = vi.fn(async () => {});
      const timeoutError = new TimeoutError({
        message: "ConferenceSession join timed out after 1000ms",
        operation: "joinRTKRoom",
        timeoutMs: 1000,
      });

      let attemptCount = 0;
      (client as any)._joinRealtimeKitEffect = vi.fn(() => {
        attemptCount += 1;
        if (attemptCount < 3) {
          return Effect.fail(timeoutError);
        }
        return Effect.succeed(undefined);
      });

      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: TimerHandler) => {
        if (typeof handler === "function") handler();
        return 0 as any;
      }) as any;

      try {
        await (client as any)._joinRealtimeKitWithRetry({ join } as any, {
          cohort: "test",
          policy: {
            name: "test-policy",
            timeoutMs: 1000,
            retryDelaysMs: [10, 20],
          },
        });
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }

      const attemptEvents = wideEventsReceived.filter((event) => event.eventType === "room.join.rtk.attempt");
      expect(attemptEvents).toHaveLength(3);
      expect(attemptEvents.map((event) => event.outcome)).toEqual(["timeout", "timeout", "success"]);
      expect(attemptEvents.map((event) => event.data?.attempt)).toEqual([1, 2, 3]);
      expect(attemptEvents.map((event) => event.data?.delayMs)).toEqual([10, 20, 0]);
      expect(attemptEvents.map((event) => event.data?.timeoutVsError)).toEqual(["timeout", "timeout", "none"]);
      expect(attemptEvents.every((event) => typeof event.data?.attemptDurationMs === "number" && (event.data?.attemptDurationMs as number) >= 0 && event.durationMs >= 0)).toBe(true);
    });

    it("fails after max RTK join retry attempts", async () => {
      const client = new ConferenceClient({
        apiUrl: DEFAULT_API_URL,
        token: "chalk_access_token",
      });
      const join = vi.fn(async () => {});
      const joinEffect = vi.fn(() =>
        Effect.fail(
          new TimeoutError({
            message: "ConferenceSession join timed out after 30000ms",
            operation: "joinRTKRoom",
            timeoutMs: 30000,
          }),
        ),
      );
      (client as any)._joinRealtimeKitEffect = joinEffect;
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: TimerHandler) => {
        if (typeof handler === "function") handler();
        return 0 as any;
      }) as any;

      try {
        await expect((client as any)._joinRealtimeKitWithRetry({ join } as any)).rejects.toThrow("Failed to join room after 5 attempts: ConferenceSession join timed out after 30000ms");
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
      const join = vi.fn(
        () =>
          new Promise<void>(() => {
            // Keep unresolved to simulate an in-flight join.
          }),
      );
      const timeoutError = new TimeoutError({
        message: "ConferenceSession join timed out after 30000ms",
        operation: "joinRTKRoom",
        timeoutMs: 30000,
      });
      (client as any)._joinRealtimeKitEffect = vi.fn(() => Effect.fail(timeoutError));

      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((handler: TimerHandler) => {
        if (typeof handler === "function") handler();
        return 0 as any;
      }) as any;

      try {
        await expect((client as any)._joinRealtimeKitWithRetry({ join } as any)).rejects.toThrow("Failed to join room after 5 attempts");
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }

      expect(join).toHaveBeenCalledTimes(5);
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
