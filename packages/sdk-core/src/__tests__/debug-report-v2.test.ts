import { describe, expect, it } from "bun:test";
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
        navigator: { userAgent: "test-agent" },
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
              access_token:
                "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJjaGFsayIsInN1YiI6ImNsYWltOjEyMyIsInRlbmFudF9pZCI6InRlbmFudC0xIiwid29ya3NwYWNlX2lkIjoid29ya3NwYWNlLTEiLCJyb29tX2lkIjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAwIiwicm9sZSI6Imhvc3QiLCJleHAiOjE3NzQ2MDg3OTJ9.c2lnbmF0dXJl",
            },
          },
          {
            id: "fetch-2",
            timestamp: "2026-03-27T09:53:13.025Z",
            method: "POST",
            url: "http://localhost:8080/api/v1/rooms/b697f1d1-6682-479c-9e20-7b6237de0caf/participants",
            requestHeaders: {
              authorization: "Bearer secret-token",
            },
            status: 404,
            ok: false,
            responseBody: {
              error: "room not found",
            },
          },
        ],
        websocket: [],
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
              message: "join failed",
            },
            data: {},
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
        },
      },
    });

    expect(report.meta.schemaVersion).toBe("chalk-debug-report/v2");
    expect(report.summary.failureClass).toBe("room_join");
    expect(report.summary.derived.roomIdFormatValid).toBe(true);
    expect(report.summary.derived.rtkPreloadReached).toBe(true);
    expect(report.summary.derived.rtcJoinStarted).toBe(true);
    expect(report.summary.derived.rtcJoinSucceeded).toBe(false);
    expect(report.authContext.activeToken?.tenantId).toBe("tenant-1");
    expect(report.browser.document.cookie).toBe("[REDACTED]");
    expect(report.browser.document.cookieNames).toEqual(["session", "other"]);
    expect(report.logs.snapshot.fetch[1]?.requestHeaders?.authorization).toBe("[REDACTED]");
  });
});
