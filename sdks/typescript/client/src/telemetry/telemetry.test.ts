import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJourneyIntakeExporter, createTelemetryClient, type TelemetryClient } from "./client";
import { createKeyValueTelemetryStorage, createMemoryTelemetryStorage } from "./storage";
import { withSyncTelemetryCorrelation } from "./sync";
import { makeDeferredFacadeExporter } from "./test-support";
import { createTraceContext, parseTraceparent } from "./trace";
import type { JourneyIntakeEvent, TelemetryEvent } from "./types";

const clients: TelemetryClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.dispose();
  }
});

function createClient(options: ConstructorParameters<typeof TelemetryClient>[0] = {}): TelemetryClient {
  const client = createTelemetryClient({ enabled: true, ...options });
  clients.push(client);
  return client;
}

describe("TelemetryClient", () => {
  it("continues a valid parent trace with a fresh span", () => {
    const child = createTraceContext("00-11111111111111111111111111111111-2222222222222222-01");

    expect(parseTraceparent(child.traceparent)?.traceId).toBe("11111111111111111111111111111111");
    expect(child.spanId).not.toBe("2222222222222222");
  });

  it("records a root journey from start through an idempotent terminal outcome", async () => {
    const exporter = vi.fn(async () => ({ accepted_count: 3, duplicate_count: 0 }));
    const telemetry = createClient({ exporter, now: () => new Date("2026-07-11T10:00:00.000Z") });
    const journey = telemetry.startJourney({ kind: "space.join" });

    const phase = journey.phase("signaling", { transport: "websocket" });
    const terminal = journey.terminal("succeeded", { result: "connected" });

    expect(journey.terminal("succeeded")).toBe(terminal);
    expect(journey.phase("media")).toBeUndefined();
    expect(journey.context.rootJourneyId).toBe(journey.context.journeyId);
    expect(journey.headers["x-chalk-journey-id"]).toBe(journey.context.journeyId);
    expect(journey.headers.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);

    const events = telemetry.getPendingEvents();
    expect(events.map((event) => [event.name, event.sequence, event.state])).toEqual([
      ["journey.started", 1, "started"],
      ["journey.phase", 2, "in_progress"],
      ["journey.terminal", 3, "succeeded"],
    ]);
    expect(phase?.parent_event_id).toBe(events[0]?.event_id);
    expect(terminal.parent_event_id).toBe(phase?.event_id);

    await telemetry.flush();
    expect(exporter).toHaveBeenCalledTimes(1);
    const exportedEvents = exporter.mock.calls[0]?.[0] ?? [];
    expect(exportedEvents).toHaveLength(3);
    expect(exportedEvents[0]).not.toHaveProperty("version");
  });

  it("sanitizes sensitive attributes before persistence and export", async () => {
    const storage = createMemoryTelemetryStorage();
    const exporter = vi.fn(async () => {
      throw new Error("offline");
    });
    const telemetry = createClient({ exporter, storage, retryDelayMs: 60_000 });
    const sensitive = {
      access_token: "access-secret",
      Authorization: "Bearer secret",
      "space-id": "space-1",
      EpisodeId: "episode-1",
      participant_identifier: "participant-1",
    };
    const journey = telemetry.startJourney({ kind: "space.join", attributes: { ...sensitive, safe_start: "ok" } });
    journey.recordDiagnostic({ category: "episode", code: "episode.started", attributes: { ...sensitive, safe_diagnostic: "ok" } });

    const pending = telemetry.getPendingEvents();
    expect(pending[0]?.attributes).toMatchObject({ safe_start: "ok", journey_kind: "space.join" });
    expect(pending[1]?.attributes).toMatchObject({ category: "episode", code: "episode.started", safe_diagnostic: "ok" });
    for (const event of pending) {
      expect(event.attributes).not.toHaveProperty("access_token");
      expect(event.attributes).not.toHaveProperty("Authorization");
      expect(event.attributes).not.toHaveProperty("space-id");
      expect(event.attributes).not.toHaveProperty("EpisodeId");
      expect(event.attributes).not.toHaveProperty("participant_identifier");
    }

    await telemetry.flush();
    await Effect.runPromise(Effect.yieldNow);

    const persisted = await storage.load();
    const exported = exporter.mock.calls.flatMap(([events]) => events);
    expect(persisted.map((event) => event.event_id)).toEqual(pending.map((event) => event.event_id));
    expect(exported.map((event) => event.event_id)).toEqual(pending.map((event) => event.event_id));
    for (const event of [...persisted, ...exported]) {
      expect(JSON.stringify(event)).not.toContain("access-secret");
      expect(JSON.stringify(event)).not.toContain("space-1");
      expect(JSON.stringify(event)).not.toContain("episode-1");
      expect(JSON.stringify(event)).not.toContain("participant-1");
    }
  });

  it("sanitizes raw persisted v1 attributes before restore delivery and re-persistence", async () => {
    const rawEvents: readonly TelemetryEvent[] = [
      {
        version: 1,
        event_id: "restored-started",
        journey_id: "00000000-0000-4000-8000-000000000001",
        sequence: 1,
        occurred_at: "2026-07-11T10:00:00.000Z",
        name: "journey.started",
        phase: "root",
        state: "started",
        origin_kind: "client",
        first_observed_layer: "client",
        upstream_visibility: "local",
        attributes: {
          access_token: "restored-access-secret",
          Authorization: "Bearer restored-secret",
          space_id: "restored-space-id",
          episode_id: "restored-episode-id",
          participant_id: "restored-participant-id",
          journey_kind: "space.join",
          safe_restored: "ok",
        },
      },
      {
        version: 1,
        event_id: "restored-diagnostic",
        journey_id: "00000000-0000-4000-8000-000000000001",
        sequence: 2,
        occurred_at: "2026-07-11T10:00:01.000Z",
        name: "diagnostic.timeline",
        phase: "recovery",
        state: "observed",
        origin_kind: "diagnostic",
        first_observed_layer: "diagnostic",
        upstream_visibility: "local",
        attributes: {
          access_token: "restored-access-secret",
          Authorization: "Bearer restored-secret",
          space_id: "restored-space-id",
          episode_id: "restored-episode-id",
          participant_id: "restored-participant-id",
          category: "episode",
          code: "episode.started",
          metric_value: 2,
          safe_restored: "ok",
        },
      },
    ];
    let persistedValue = JSON.stringify(rawEvents);
    const writes: string[] = [];
    const storage = createKeyValueTelemetryStorage({
      async getItem() {
        return persistedValue;
      },
      async setItem(_key, value) {
        persistedValue = value;
        writes.push(value);
      },
    });
    const exporter = vi.fn(async (events: readonly JourneyIntakeEvent[]) => ({ accepted_count: events.length, duplicate_count: 0 }));
    const telemetry = createClient({ exporter, storage });

    await telemetry.flush();

    const exported = exporter.mock.calls.flatMap(([events]) => events);
    expect(exported).toHaveLength(2);
    expect(exported[0]?.attributes).toMatchObject({ journey_kind: "space.join", safe_restored: "ok" });
    expect(exported[1]?.attributes).toMatchObject({ category: "episode", code: "episode.started", metric_value: 2, safe_restored: "ok" });
    for (const event of exported) {
      expect(event.attributes).not.toHaveProperty("access_token");
      expect(event.attributes).not.toHaveProperty("Authorization");
      expect(event.attributes).not.toHaveProperty("space_id");
      expect(event.attributes).not.toHaveProperty("episode_id");
      expect(event.attributes).not.toHaveProperty("participant_id");
    }
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write).not.toContain("access_token");
      expect(write).not.toContain("Authorization");
      expect(write).not.toContain("space_id");
      expect(write).not.toContain("episode_id");
      expect(write).not.toContain("participant_id");
      expect(write).not.toContain("restored-access-secret");
      expect(write).not.toContain("restored-secret");
      expect(write).not.toContain("restored-space-id");
      expect(write).not.toContain("restored-episode-id");
      expect(write).not.toContain("restored-participant-id");
    }
    const persistedEvents = writes.flatMap((write) => JSON.parse(write) as TelemetryEvent[]);
    expect(persistedEvents.find((event) => event.event_id === "restored-started")?.attributes).toMatchObject({ journey_kind: "space.join", safe_restored: "ok" });
    expect(persistedEvents.find((event) => event.event_id === "restored-diagnostic")?.attributes).toMatchObject({ category: "episode", code: "episode.started", metric_value: 2, safe_restored: "ok" });
    expect(JSON.parse(persistedValue)).toEqual([]);
  });

  it("caps a configured maxBatchSize at the intake limit without dropping events", async () => {
    const exporter = vi.fn(async (events: readonly JourneyIntakeEvent[]) => ({ accepted_count: events.length, duplicate_count: 0 }));
    const telemetry = createClient({ exporter, maxBatchSize: 200, maxQueueSize: 201 });
    const journey = telemetry.startJourney({ kind: "space.join" });
    for (let index = 0; index < 200; index += 1) {
      journey.recordDiagnostic({ category: "network", code: `sample-${index}` });
    }
    const queuedEventIds = telemetry.getPendingEvents().map((event) => event.event_id);

    await telemetry.flush();

    const batches = exporter.mock.calls.map(([events]) => events);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 1]);
    expect(batches.flatMap((batch) => batch.map((event) => event.event_id))).toEqual(queuedEventIds);
    expect(telemetry.getExporterHealth()).toMatchObject({ droppedEvents: 0, exportedEvents: 201, queueDepth: 0 });
  });

  it("links child journeys to a root journey for fanout", () => {
    const telemetry = createClient();
    const root = telemetry.startJourney({ kind: "space.join" });
    const child = root.startChild({ kind: "token.refresh" });

    const events = telemetry.getPendingEvents();
    const link = events.find((event) => event.name === "journey.linked");
    const childStart = events.find((event) => event.journey_id === child.context.journeyId && event.name === "journey.started");

    expect(child.context.rootJourneyId).toBe(root.context.rootJourneyId);
    expect(link?.attributes).toMatchObject({ child_journey_id: child.context.journeyId, relationship: "fanout" });
    expect(childStart?.parent_event_id).toBe(link?.event_id);
    expect(child.context.traceparent.split("-")[1]).toBe(root.context.traceparent.split("-")[1]);
  });

  it("normalizes invalid caller journey identifiers to API-compatible UUIDs", () => {
    const telemetry = createClient();
    const journey = telemetry.startJourney({ kind: "space.join", journeyId: "legacy-123" });

    expect(journey.context.journeyId).not.toBe("legacy-123");
    expect(journey.context.journeyId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });

  it("propagates journey correlation through sync hello frames", () => {
    const telemetry = createClient();
    const journey = telemetry.startJourney({ kind: "space.join", tracestate: "chalk=local" });
    const hello = withSyncTelemetryCorrelation({ type: "hello" as const, protocol: 1 }, journey.context);

    expect(hello).toMatchObject({
      type: "hello",
      protocol: 1,
      journey_id: journey.context.journeyId,
      traceparent: journey.context.traceparent,
      tracestate: "chalk=local",
    });
  });

  it("keeps failed exports persisted, retries the same ids, and permits server-side dedupe", async () => {
    const storage = createMemoryTelemetryStorage();
    const offlineExporter = vi.fn(async () => {
      throw new Error("offline");
    });
    const telemetry = createClient({ exporter: offlineExporter, retryDelayMs: 60_000, storage });
    const journey = telemetry.startJourney({ kind: "space.join" });
    journey.phase("authentication");
    journey.terminal("failed", { code: "network_unavailable" });

    await telemetry.flush();
    await Effect.runPromise(Effect.yieldNow);

    expect(telemetry.getExporterHealth()).toMatchObject({ failedBatches: 1, status: "degraded" });
    expect((await storage.load()).map((event) => event.event_id)).toEqual(telemetry.getPendingEvents().map((event) => event.event_id));

    const eventIds = telemetry.getPendingEvents().map((event) => event.event_id);
    telemetry.dispose();
    const recoveredExporter = vi.fn(async (events) => ({ accepted_count: 0, duplicate_count: events.length }));
    const recovered = createClient({ exporter: recoveredExporter, storage });
    await recovered.flush();

    expect(recoveredExporter).toHaveBeenCalledTimes(1);
    expect(recoveredExporter.mock.calls[0]?.[0].map((event) => event.event_id)).toEqual(eventIds);
    expect(recovered.getPendingEvents()).toHaveLength(0);
    expect(recovered.getExporterHealth()).toMatchObject({ exportedEvents: 3, queueDepth: 0, status: "healthy" });
  });

  it("bounds the queue and emits a drop health signal when it overflows", async () => {
    const dropped = vi.fn();
    const telemetry = createClient({ maxQueueSize: 2, onDrop: dropped });
    const journey = telemetry.startJourney({ kind: "space.join" });
    journey.phase("authentication");
    journey.phase("signaling");

    await Effect.runPromise(Effect.yieldNow);

    expect(telemetry.getPendingEvents().map((event) => event.sequence)).toEqual([2, 3]);
    expect(telemetry.getExporterHealth()).toMatchObject({ droppedEvents: 1, queueDepth: 2 });
    expect(dropped).toHaveBeenCalledWith([expect.objectContaining({ sequence: 1 })]);
  });

  it("does not wait for a slow exporter on the Space join path", async () => {
    const exporter = makeDeferredFacadeExporter();
    const blockedExport = exporter.holdNext();
    const telemetry = createClient({ exporter: exporter.exporter });
    const journey = telemetry.startJourney({ kind: "space.join" });

    const activeFlush = telemetry.flush();
    await blockedExport.started();

    const terminal = journey.terminal("cancelled");
    expect(terminal.sequence).toBe(2);
    expect(telemetry.getPendingEvents()).toHaveLength(2);

    blockedExport.release();
    await activeFlush;
    await telemetry.flush();
    expect(telemetry.getPendingEvents()).toHaveLength(0);
  });

  it("records aggregate WebRTC state and stats without raw media fields", () => {
    const telemetry = createClient();
    const journey = telemetry.startJourney({ kind: "space.join" });
    const event = journey.recordRtcSummary({ connectionState: "connected", iceConnectionState: "completed", signalingState: "stable" }, [
      { type: "inbound-rtp", bytesReceived: 1200, packetsReceived: 30, packetsLost: 2, framesDropped: 1, jitter: 0.004 },
      { type: "outbound-rtp", bytesSent: 800, packetsSent: 12 },
      { type: "candidate-pair", roundTripTime: 0.03 },
    ]);

    expect(event).toMatchObject({ name: "rtc.summary", phase: "media", origin_kind: "rtc" });
    expect(event?.attributes).toMatchObject({
      connection_state: "connected",
      ice_connection_state: "completed",
      bytes_received: 1200,
      bytes_sent: 800,
      packets_lost: 2,
      jitter_ms: 4,
      round_trip_time_ms: 30,
    });
    expect(event?.attributes).not.toHaveProperty("candidate");
    expect(event?.attributes).not.toHaveProperty("track");
    expect(event?.attributes).not.toHaveProperty("sdp");
  });

  it("keeps a bounded diagnostics timeline and bounds custom attributes", () => {
    const telemetry = createClient({ maxTimelineEntries: 3 });
    const journey = telemetry.startJourney({ kind: "space.join" });
    journey.recordDiagnostic({ category: "network", code: "offline" });
    journey.recordDiagnostic({ category: "recovery", code: "retrying" });
    const event = journey.record({
      name: "diagnostic.timeline",
      phase: "recovery",
      state: "observed",
      origin_kind: "diagnostic",
      attributes: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`metric_${index}`, "x".repeat(300)])),
    });

    expect(telemetry.getTimeline()).toHaveLength(3);
    expect(telemetry.getTimeline().map((entry) => entry.name)).toEqual(["diagnostic.timeline", "diagnostic.timeline", "diagnostic.timeline"]);
    expect(Object.keys(event.attributes ?? {})).toHaveLength(24);
    expect(event.attributes?.metric_0).toHaveLength(256);
  });

  it("records connection diagnostics for framework bindings", () => {
    const telemetry = createClient();
    const journey = telemetry.startJourney({ kind: "space.join" });

    const event = journey.recordDiagnostic({ category: "connection", code: "join.media.succeeded", phase: "media", state: "succeeded" });

    expect(event?.attributes).toMatchObject({ category: "connection", code: "join.media.succeeded" });
  });

  it("uses Episode for lifecycle diagnostics and excludes domain identifiers", () => {
    const telemetry = createClient();
    const journey = telemetry.startJourney({ kind: "space.join" });

    const event = journey.recordDiagnostic({ category: "episode", code: "episode.started", phase: "signaling" });

    expect(event?.attributes).toMatchObject({ category: "episode", code: "episode.started" });
    expect(event?.attributes).not.toHaveProperty("space_id");
    expect(event?.attributes).not.toHaveProperty("episode_id");
    expect(event?.attributes).not.toHaveProperty("participant_id");
    expect(event?.attributes).not.toHaveProperty("access_token");
  });

  it("reserves canonical diagnostic fields ahead of 24 caller attributes", () => {
    const telemetry = createClient();
    const journey = telemetry.startJourney({ kind: "space.join" });
    const event = journey.recordDiagnostic({
      category: "episode",
      code: "episode.started",
      attributes: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`custom_${index}`, index])),
    });

    expect(Object.keys(event?.attributes ?? {})).toHaveLength(24);
    expect(event?.attributes).toMatchObject({ category: "episode", code: "episode.started", custom_0: 0 });
    expect(event?.attributes).not.toHaveProperty("custom_22");
  });

  it("records numeric diagnostics only while the journey is active", () => {
    const telemetry = createClient();
    const journey = telemetry.startJourney({ kind: "space.join" });

    const metric = journey.recordDiagnostic({
      category: "whiteboard_renderer",
      code: "whiteboard.renderer.ready",
      metricValue: 27,
      phase: "media",
      attributes: { span_id: "space-join-span-1", outcome: "succeeded", failure_code: "media_start_failed" },
    });
    journey.terminal("succeeded");

    expect(metric).toMatchObject({
      name: "diagnostic.timeline",
      phase: "media",
      attributes: {
        category: "whiteboard_renderer",
        code: "whiteboard.renderer.ready",
        metric_value: 27,
        span_id: "space-join-span-1",
        outcome: "succeeded",
        failure_code: "media_start_failed",
      },
    });
    expect(
      journey.recordDiagnostic({
        category: "whiteboard_renderer",
        code: "whiteboard.renderer.termination",
        metricValue: 1,
        phase: "media",
        state: "failed",
      }),
    ).toBeUndefined();
    expect(telemetry.getPendingEvents().map((event) => event.name)).toEqual(["journey.started", "diagnostic.timeline", "journey.terminal"]);
  });

  it("posts batches to the configured API journey intake path", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted_count: 1, duplicate_count: 0 }), { status: 202 }));
    const exporter = createJourneyIntakeExporter({ baseUrl: "https://api.chalk.test/api", credentials: "include", fetch: fetchMock as typeof fetch });
    const telemetry = createClient({ exporter });
    telemetry.startJourney({ kind: "space.join" });

    await telemetry.flush();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.chalk.test/v1/telemetry/journey-events");
    expect(init).toMatchObject({ credentials: "include", method: "POST" });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init?.headers).get("x-chalk-journey-id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(new Headers(init?.headers).get("traceparent")).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    expect(JSON.parse(String(init?.body))).toEqual({
      events: [
        expect.objectContaining({
          event_id: expect.any(String),
          journey_id: expect.any(String),
          sequence: 1,
          name: "journey.started",
        }),
      ],
    });
  });

  it("uses an unload-safe export for an explicit keepalive flush", async () => {
    const exporter = vi.fn(async () => ({ accepted_count: 1, duplicate_count: 0 }));
    const telemetry = createClient({ exporter });
    telemetry.startJourney({ kind: "web.application" });

    await telemetry.flush({ keepalive: true });

    expect(exporter.mock.calls[0]?.[1]).toEqual({ keepalive: true });
  });

  it("re-sends the in-flight journey and terminal event with keepalive", async () => {
    const exporter = makeDeferredFacadeExporter();
    const blockedExport = exporter.holdNext();
    const telemetry = createClient({ exporter: exporter.exporter });
    const journey = telemetry.startJourney({ kind: "web.application" });

    const activeFlush = telemetry.flush();
    await blockedExport.started();
    journey.terminal("succeeded", { result: "page_closed" });
    await telemetry.flush({ keepalive: true });

    expect(exporter.calls[1]).toMatchObject({ events: [expect.objectContaining({ name: "journey.started" }), expect.objectContaining({ name: "journey.terminal" })], options: { keepalive: true } });

    blockedExport.release();
    await activeFlush;
    expect(telemetry.getPendingEvents()).toHaveLength(0);
  });
});
