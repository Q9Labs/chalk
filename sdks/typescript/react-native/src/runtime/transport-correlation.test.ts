import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeSessionTelemetry } from "../telemetry";
import { correlateNativeTransports, trackNativeTokenProvider } from "./transport-correlation";

const initialFetch = globalThis.fetch;
const initialWebSocket = globalThis.WebSocket;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalThis.fetch = initialFetch;
  globalThis.WebSocket = initialWebSocket;
});

describe("correlateNativeTransports", () => {
  it("adds correlation headers only to requests under the configured API URL", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetch;
    const stop = correlateNativeTransports({ apiUrl: "https://api.chalk.test/v1", telemetry });
    cleanups.push(stop);

    await globalThis.fetch("https://api.chalk.test/v1/sessions", { headers: { authorization: "Bearer token" } });
    await globalThis.fetch("https://unrelated.test/v1/sessions");

    const correlatedInit = fetch.mock.calls[0]?.[1];
    const headers = new Headers(correlatedInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("traceparent")).toBe(telemetry.context.traceparent);
    expect(headers.get("x-chalk-journey-id")).toBe(telemetry.context.journeyId);
    expect(fetch.mock.calls[1]).toEqual(["https://unrelated.test/v1/sessions", undefined]);

    stop();
    cleanups.pop();
    expect(globalThis.fetch).toBe(fetch);
  });

  it("adds handshake headers and correlation fields to matching sync frames", () => {
    const sockets: FakeWebSocket[] = [];
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string, protocols?: string | string[], options?: Record<string, unknown>) {
        super(url, protocols, options);
        sockets.push(this);
      }
    }
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
    const stop = correlateNativeTransports({ apiUrl: "https://api.chalk.test", wsUrl: "wss://sync.chalk.test/socket", telemetry });
    cleanups.push(stop);

    const socket = new globalThis.WebSocket("wss://sync.chalk.test/socket/rooms", ["chalk"], { headers: { authorization: "Bearer token" } } as never);
    socket.send(JSON.stringify({ type: "room.join" }));
    socket.send("keepalive");

    expect(sockets[0]?.options).toEqual({
      headers: {
        authorization: "Bearer token",
        traceparent: telemetry.context.traceparent,
        "x-chalk-journey-id": telemetry.context.journeyId,
      },
    });
    expect(JSON.parse(String(sockets[0]?.sent[0]))).toEqual({ type: "room.join", ...telemetry.syncCorrelation });
    expect(sockets[0]?.sent[1]).toBe("keepalive");

    stop();
    cleanups.pop();
    expect(globalThis.WebSocket).toBe(TestWebSocket);
  });

  it("keeps concurrent same-origin sessions associated with their own credentials", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetch;
    const stopFirst = correlateNativeTransports({ apiUrl: "https://api.chalk.test", credentials: ["first-token"], telemetry });
    const stopSecond = correlateNativeTransports({ apiUrl: "https://api.chalk.test", credentials: ["second-token"], telemetry: secondTelemetry });
    cleanups.push(stopFirst, stopSecond);

    await globalThis.fetch("https://api.chalk.test/v1/sessions", { headers: { authorization: "Bearer first-token" } });
    await globalThis.fetch("https://api.chalk.test/v1/sessions", { headers: { authorization: "Bearer second-token" } });
    await globalThis.fetch("https://api.chalk.test/v1/sessions");

    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-chalk-journey-id")).toBe(telemetry.context.journeyId);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("x-chalk-journey-id")).toBe(secondTelemetry.context.journeyId);
    expect(fetch.mock.calls[2]).toEqual(["https://api.chalk.test/v1/sessions", undefined]);
  });

  it("uses existing journey context to select a concurrent same-origin session", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetch;
    cleanups.push(correlateNativeTransports({ apiUrl: "https://api.chalk.test", telemetry }), correlateNativeTransports({ apiUrl: "https://api.chalk.test", telemetry: secondTelemetry }));

    await globalThis.fetch("https://api.chalk.test/v1/sessions", { headers: secondTelemetry.apiHeaders });

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-chalk-journey-id")).toBe(secondTelemetry.context.journeyId);
    expect(headers.get("traceparent")).toBe(secondTelemetry.context.traceparent);
  });

  it("keeps concurrent same-origin WebSockets bound to their initiating session", () => {
    const sockets: FakeWebSocket[] = [];
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string, protocols?: string | string[], options?: Record<string, unknown>) {
        super(url, protocols, options);
        sockets.push(this);
      }
    }
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
    cleanups.push(
      correlateNativeTransports({ apiUrl: "https://api.chalk.test", wsUrl: "wss://sync.chalk.test/socket", credentials: ["first-token"], telemetry }),
      correlateNativeTransports({ apiUrl: "https://api.chalk.test", wsUrl: "wss://sync.chalk.test/socket", credentials: ["second-token"], telemetry: secondTelemetry }),
    );

    const first = new globalThis.WebSocket("wss://sync.chalk.test/socket/rooms?authToken=first-token");
    const second = new globalThis.WebSocket("wss://sync.chalk.test/socket/rooms?authToken=second-token");
    first.send(JSON.stringify({ type: "room.join" }));
    second.send(JSON.stringify({ type: "room.join" }));

    expect(JSON.parse(String(sockets[0]?.sent[0]))).toEqual({ type: "room.join", ...telemetry.syncCorrelation });
    expect(JSON.parse(String(sockets[1]?.sent[0]))).toEqual({ type: "room.join", ...secondTelemetry.syncCorrelation });
    expect((sockets[0]?.options?.headers as Record<string, string>)["x-chalk-journey-id"]).toBe(telemetry.context.journeyId);
    expect((sockets[1]?.options?.headers as Record<string, string>)["x-chalk-journey-id"]).toBe(secondTelemetry.context.journeyId);
  });

  it("matches concurrent sessions after their dynamic token providers resolve", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const sockets: FakeWebSocket[] = [];
    class TestWebSocket extends FakeWebSocket {
      constructor(url: string, protocols?: string | string[], options?: Record<string, unknown>) {
        super(url, protocols, options);
        sockets.push(this);
      }
    }
    globalThis.fetch = fetch;
    globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
    const firstProvider = trackNativeTokenProvider(async () => "first-dynamic-token");
    const secondProvider = trackNativeTokenProvider(async () => "second-dynamic-token");
    cleanups.push(
      correlateNativeTransports({ apiUrl: "https://api.chalk.test", wsUrl: "wss://sync.chalk.test/socket", dynamicCredentials: firstProvider.credentials, telemetry }),
      correlateNativeTransports({ apiUrl: "https://api.chalk.test", wsUrl: "wss://sync.chalk.test/socket", dynamicCredentials: secondProvider.credentials, telemetry: secondTelemetry }),
    );

    await Promise.all([firstProvider.provider?.(), secondProvider.provider?.()]);
    await globalThis.fetch("https://api.chalk.test/v1/sessions", { headers: { authorization: "Bearer second-dynamic-token" } });
    const socket = new globalThis.WebSocket("wss://sync.chalk.test/socket/rooms?authToken=first-dynamic-token");
    socket.send(JSON.stringify({ type: "room.join" }));

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-chalk-journey-id")).toBe(secondTelemetry.context.journeyId);
    expect(headers.get("traceparent")).toBe(secondTelemetry.context.traceparent);
    expect(JSON.parse(String(sockets[0]?.sent[0]))).toEqual({ type: "room.join", ...telemetry.syncCorrelation });
    expect((sockets[0]?.options?.headers as Record<string, string>)["x-chalk-journey-id"]).toBe(telemetry.context.journeyId);
  });
});

class FakeWebSocket {
  readonly sent: unknown[] = [];

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
    readonly options?: Record<string, unknown>,
  ) {}

  send(data: unknown): void {
    this.sent.push(data);
  }
}

const telemetry: NativeSessionTelemetry = {
  apiHeaders: {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "x-chalk-journey-id": "00000000-0000-4000-8000-000000000001",
  },
  context: {
    journeyId: "00000000-0000-4000-8000-000000000001",
    rootJourneyId: "00000000-0000-4000-8000-000000000001",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  },
  syncCorrelation: {
    journey_id: "00000000-0000-4000-8000-000000000001",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  },
};

const secondTelemetry: NativeSessionTelemetry = {
  apiHeaders: {
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    "x-chalk-journey-id": "00000000-0000-4000-8000-000000000002",
  },
  context: {
    journeyId: "00000000-0000-4000-8000-000000000002",
    rootJourneyId: "00000000-0000-4000-8000-000000000002",
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  },
  syncCorrelation: {
    journey_id: "00000000-0000-4000-8000-000000000002",
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  },
};
