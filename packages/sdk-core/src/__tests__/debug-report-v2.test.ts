import { describe, expect, it } from "vitest";
import { buildStructuredDebugReport } from "../debug/report-v2.ts";

describe("buildStructuredDebugReport", () => {
  it("builds a diagnosis-first report and redacts tokens", () => {
    const report = buildStructuredDebugReport({
      generatedAt: "2026-03-27T09:53:13.066Z",
      reportType: "sdk-react-full",
      app: {
        name: "chalk-sdk-react",
      },
      location: {
        url: "http://localhost:3070/room/b697f1d1-6682-479c-9e20-7b6237de0caf",
        origin: "http://localhost:3070",
        host: "localhost:3070",
        pathname: "/room/b697f1d1-6682-479c-9e20-7b6237de0caf",
        search: "",
        hash: "",
        title: "Chalk",
        referrer: null,
        historyLength: 2,
        visibilityState: "visible",
      },
      browser: {
        navigator: {
          userAgent: "test-agent",
          online: true,
          connection: {
            effectiveType: "4g",
            downlink: 3.2,
            rtt: 120,
            saveData: false,
          },
        },
        permissions: { camera: "prompt" },
        devices: [],
        storage: {
          localStorage: {
            chalk_internal_client_id_v1: "client-123",
          },
          sessionStorage: {},
        },
        document: {
          cookie: "session=abc; other=def",
          visibilityState: "visible",
        },
      },
      context: {
        error: "room not found",
        supportCode: "CHK-20260327-095313-002",
        selectedClassroomId: "classroom-42",
      },
      logs: {
        generatedAt: "2026-03-27T09:53:13.095Z",
        fetch: [
          {
            id: "fetch-1",
            timestamp: "2026-03-27T09:53:12.134Z",
            method: "GET",
            url: "http://localhost:8080/api/v1/internal/auth/access-token",
            status: 200,
            ok: true,
            responseBody: {
              access_token: "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJjaGFsayIsInN1YiI6ImNsYWltOjEyMyIsInRlbmFudF9pZCI6InRlbmFudC0xIiwid29ya3NwYWNlX2lkIjoid29ya3NwYWNlLTEiLCJyb29tX2lkIjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAwIiwicm9sZSI6Imhvc3QiLCJleHAiOjE3NzQ2MDg3OTJ9.c2lnbmF0dXJl",
            },
          },
          {
            id: "fetch-2",
            timestamp: "2026-03-27T09:53:13.025Z",
            method: "POST",
            url: "http://localhost:8080/api/v1/rooms/b697f1d1-6682-479c-9e20-7b6237de0caf/participants",
            requestHeaders: {
              authorization: "Bearer secret-token",
              "x-api-key": "sk_test_1234567890",
            },
            responseHeaders: {
              "x-request-id": "req-123",
              "x-correlation-id": "corr-987",
            },
            status: 404,
            ok: false,
            responseBody: {
              error: "room not found",
            },
          },
        ],
        websocket: [
          {
            id: "ws-1",
            timestamp: "2026-03-27T09:53:12.140Z",
            url: "wss://localhost:8080/api/v1/ws",
            event: "construct",
            readyState: 0,
          },
          {
            id: "ws-2",
            timestamp: "2026-03-27T09:53:12.180Z",
            url: "wss://localhost:8080/api/v1/ws",
            event: "open",
            readyState: 1,
          },
          {
            id: "ws-3",
            timestamp: "2026-03-27T09:53:13.030Z",
            url: "wss://localhost:8080/api/v1/ws",
            event: "close",
            readyState: 3,
            code: 1006,
            reason: "ice connection failed",
            wasClean: false,
          },
        ],
        console: [],
        runtimeErrors: [],
        wideEvents: [
          {
            eventId: "evt-1",
            eventType: "room.join.rtk.preload",
            timestamp: "2026-03-27T09:53:12.100Z",
            sdk: {
              version: "0.0.79",
              platform: "browser",
              userAgent: "test-agent",
            },
            sessionId: "sess-1",
            durationMs: 1,
            outcome: "success",
            data: {},
          },
          {
            eventId: "evt-2",
            eventType: "room.join.rtk.attempt",
            timestamp: "2026-03-27T09:53:12.110Z",
            sdk: {
              version: "0.0.79",
              platform: "browser",
              userAgent: "test-agent",
            },
            sessionId: "sess-1",
            durationMs: 10,
            outcome: "error",
            error: {
              code: "RTK_JOIN_ERROR",
              message: "ice connection failed",
            },
            data: {
              attempt: 1,
              totalAttempts: 5,
              timeoutMs: 15000,
              rtkJoinPolicy: {
                policy: {
                  retryDelaysMs: [750, 1500, 3000, 5000],
                },
              },
            },
          },
        ],
        incidents: [],
        breadcrumbs: [],
        sections: {
          chalkSession: {
            diagnostics: {
              roomStateStatus: "disconnected",
            },
          },
          chalkProvider: {
            providerInstanceId: "provider-1",
            cache: {
              cacheKey: "https://api.chalk.local::room:abc",
              sessionCacheKey: "room:abc",
              reusedExistingSession: true,
            },
            auth: {
              mode: "token-provider",
            },
            room: {
              diagnostics: {
                roomStateRoomId: "b697f1d1-6682-479c-9e20-7b6237de0caf",
                connectedInputRoomId: "b697f1d1-6682-479c-9e20-7b6237de0caf",
                localParticipantId: "participant-1",
                clientConnectionState: "disconnected",
                websocketConnectionState: "connected",
                activeRoomHasRtkMeeting: true,
                rtkDiagnostics: {
                  available: true,
                  self: {
                    audioEnabled: true,
                    videoEnabled: false,
                    audioTrack: {
                      kind: "audio",
                      enabled: true,
                      muted: false,
                      readyState: "live",
                    },
                  },
                  room: {
                    joined: false,
                    iceConnectionState: "failed",
                  },
                  participants: {
                    size: 1,
                  },
                  media: null,
                  transport: {
                    iceConnectionState: "failed",
                    connectionState: "failed",
                  },
                  publicStateFields: [
                    {
                      path: "rtk.transport.iceConnectionState",
                      value: "failed",
                    },
                  ],
                  limitations: ["test limitation"],
                },
              },
              recentConnectedRoomIds: ["room-old", "b697f1d1-6682-479c-9e20-7b6237de0caf"],
              previousSession: {
                cacheKey: "https://api.chalk.local::room:old",
                roomId: "room-old",
              },
            },
            selectedContext: {
              selectedTenantId: "tenant-1",
              selectedWorkspaceId: "workspace-1",
            },
          },
        },
      },
    });

    expect(report.meta.schemaVersion).toBe("chalk-debug-report/v2");
    expect(report.summary.failureClass).toBe("room_join");
    expect(report.summary.derived.roomIdFormatValid).toBe(true);
    expect(report.summary.derived.rtkPreloadReached).toBe(true);
    expect(report.summary.derived.rtcJoinStarted).toBe(true);
    expect(report.summary.derived.rtcJoinSucceeded).toBe(false);
    expect(report.summary.derived.rtcJoinFailed).toBe(true);
    expect(report.meta.app.sdkCoreVersion).toBe("0.0.79");
    expect(report.authContext.activeToken?.tenantId).toBe("tenant-1");
    expect(report.authContext.tokenClaims.tenantId).toBe("tenant-1");
    expect(report.authContext.apiKeyIdentifierPrefix).toBe("sk_test_");
    expect(report.networkSummary.participantJoinRequest.requestId).toBe("req-123");
    expect(report.networkSummary.participantJoinRequest.correlationId).toBe("corr-987");
    expect(report.tenantContext.selectedClassroomId).toBe("classroom-42");
    expect(report.tenantContext.selectedWorkspaceId).toBe("workspace-1");
    expect(report.sessionContext.cache.reusedExistingSession).toBe(true);
    expect(report.sessionContext.room.connectedInputRoomId).toBe("b697f1d1-6682-479c-9e20-7b6237de0caf");
    expect(report.sessionContext.room.activeRoomHasRtkMeeting).toBe(true);
    expect(report.rtkVisibility.available).toBe(true);
    expect(report.rtkVisibility.client?.self?.audioTrack?.readyState).toBe("live");
    expect(report.rtkVisibility.client?.transport?.iceConnectionState).toBe("failed");
    expect(report.rtkVisibility.joinAttempts.count).toBe(1);
    expect(report.rtkVisibility.joinAttempts.configuredTotalAttempts).toBe(5);
    expect(report.rtkVisibility.iceMediaFailureHints.matched).toBe(true);
    expect(report.networkSummary.networkHints.effectiveType).toBe("4g");
    expect(report.networkSummary.websocket.opens).toBe(1);
    expect(report.networkSummary.websocket.latestClose?.reason).toBe("ice connection failed");
    expect(report.timeline.some((entry) => entry.label === "room.join.rtk.attempt")).toBe(true);
    expect(report.browser.document.cookie).toBe("[REDACTED]");
    expect(report.browser.document.cookieNames).toEqual(["session", "other"]);
    expect(report.logs.snapshot.fetch[1]?.requestHeaders?.authorization).toBe("[REDACTED]");
    expect(report.logs.snapshot.fetch[1]?.requestHeaders?.["x-api-key"]).toBe("[REDACTED:sk_test_]");
  });

  it("classifies RTK join failures after participant creation separately from API join failures", () => {
    const report = buildStructuredDebugReport({
      generatedAt: "2026-03-27T09:53:13.066Z",
      reportType: "sdk-react-full",
      app: {
        name: "chalk-sdk-react",
      },
      location: {
        url: "http://localhost:3070/room/b697f1d1-6682-479c-9e20-7b6237de0caf",
        origin: "http://localhost:3070",
        host: "localhost:3070",
        pathname: "/room/b697f1d1-6682-479c-9e20-7b6237de0caf",
        search: "",
        hash: "",
      },
      browser: {
        navigator: { online: true },
        permissions: {},
        devices: [],
        storage: {
          localStorage: {},
          sessionStorage: {},
        },
        document: {},
      },
      logs: {
        generatedAt: "2026-03-27T09:53:13.095Z",
        fetch: [
          {
            id: "fetch-1",
            timestamp: "2026-03-27T09:53:12.025Z",
            method: "POST",
            url: "http://localhost:8080/api/v1/rooms/b697f1d1-6682-479c-9e20-7b6237de0caf/participants",
            status: 201,
            ok: true,
          },
        ],
        websocket: [],
        console: [],
        runtimeErrors: [],
        wideEvents: [
          {
            eventId: "evt-1",
            eventType: "room.join.rtk.attempt",
            timestamp: "2026-03-27T09:53:13.025Z",
            sdk: {
              version: "0.0.85",
              platform: "browser",
            },
            sessionId: "sess-1",
            durationMs: 100,
            outcome: "error",
            error: {
              code: "RTK_JOIN_ERROR",
              message: "ice connection failed",
            },
            data: {
              attempt: 1,
              totalAttempts: 1,
            },
          },
        ],
        incidents: [],
        breadcrumbs: [],
        sections: {},
      },
    });

    expect(report.summary.failureClass).toBe("rtk_join");
    expect(report.summary.headline).toBe("RealtimeKit join or media transport failed after participant creation");
    expect(report.networkSummary.participantJoinRequest.status).toBe(201);
    expect(report.rtkVisibility.iceMediaFailureHints.matched).toBe(true);
  });
});
