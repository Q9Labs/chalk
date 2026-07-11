import { describe, expect, it, vi } from "vitest";
import { createJourneyIntakeExporter, encodedByteLength, MAX_JOURNEY_INTAKE_BATCH_BODY_BYTES, TelemetryExportError, TelemetryPayloadTooLargeError } from "./exporter";
import type { JourneyIntakeEvent } from "./types";

describe("createJourneyIntakeExporter", () => {
  it("rejects non-successful intake responses", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    const exporter = createJourneyIntakeExporter({ baseUrl: "https://api.chalk.test", fetch: fetchMock as typeof fetch });

    await expect(exporter([])).rejects.toThrow("HTTP 503");
  });

  it("classifies permanent and transient HTTP failures", async () => {
    const permanent = createJourneyIntakeExporter({ baseUrl: "https://api.chalk.test", fetch: vi.fn(async () => new Response(null, { status: 400 })) as typeof fetch });
    const transient = createJourneyIntakeExporter({ baseUrl: "https://api.chalk.test", fetch: vi.fn(async () => new Response(null, { status: 429 })) as typeof fetch });

    await expect(permanent([])).rejects.toMatchObject<TelemetryExportError>({ retriable: false, status: 400 });
    await expect(transient([])).rejects.toMatchObject<TelemetryExportError>({ retriable: true, status: 429 });
  });

  it("preserves W3C flags and vendor state in headers without adding transport fields to the API body", async () => {
    const { exporter, fetchMock } = successfulExporter();
    const event = intakeEvent({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
      tracestate: "vendor=value",
    });

    await exporter([event]);

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ traceparent: event.traceparent, tracestate: "vendor=value" });
    expect(JSON.parse(String(request?.body)).events[0]).not.toHaveProperty("traceparent");
    expect(JSON.parse(String(request?.body)).events[0]).not.toHaveProperty("tracestate");
  });

  it("splits mixed parent-child journeys into header-correlated requests", async () => {
    const { exporter, fetchMock } = successfulExporter();
    const parent = intakeEvent({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "chalk=local",
    });
    const child = {
      ...parent,
      event_id: "00000000-0000-4000-8000-000000000003",
      journey_id: "00000000-0000-4000-8000-000000000004",
      sequence: 2,
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-0af7651916cd43dd-01",
    };
    const parentTerminal = { ...parent, event_id: "00000000-0000-4000-8000-000000000005", sequence: 3, name: "journey.terminal" as const, phase: "terminal" as const, state: "succeeded" as const };

    await exporter([parent, child, parentTerminal]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestContext(fetchMock.mock.calls[0]?.[1])).toEqual({ journeyId: parent.journey_id, traceparent: parent.traceparent, tracestate: parent.tracestate });
    expect(requestContext(fetchMock.mock.calls[1]?.[1])).toEqual({ journeyId: child.journey_id, traceparent: child.traceparent, tracestate: child.tracestate });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).events.map((event: JourneyIntakeEvent) => event.event_id)).toEqual([parent.event_id, parentTerminal.event_id]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).events.map((event: JourneyIntakeEvent) => event.event_id)).toEqual([child.event_id]);
  });

  it("splits oversized journey batches into API-compatible requests", async () => {
    const { exporter, fetchMock } = successfulExporter();
    const events = Array.from({ length: 201 }, (_, index) => ({
      ...intakeEvent({}),
      event_id: `event-${index}`,
      sequence: index + 1,
    }));

    await exporter(events);

    const delivered = fetchMock.mock.calls.flatMap(([, request]) => JSON.parse(String(request?.body)).events.map((event: JourneyIntakeEvent) => event.event_id));
    expect(fetchMock.mock.calls.map(([, request]) => JSON.parse(String(request?.body)).events.length)).toEqual([100, 100, 1]);
    expect(delivered).toEqual(events.map((event) => event.event_id));
  });

  it("splits attribute-heavy journey batches below the API body limit", async () => {
    const { exporter, fetchMock } = successfulExporter();
    const attributes = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`attribute_${index}`, "x".repeat(1024)]));
    const events = Array.from({ length: 100 }, (_, index) => ({
      ...intakeEvent({}),
      attributes,
      event_id: `event-${index}`,
      sequence: index + 1,
    }));

    await exporter(events);

    const bodies = fetchMock.mock.calls.map(([, request]) => String(request?.body));
    const delivered = bodies.flatMap((body) => JSON.parse(body).events.map((event: JourneyIntakeEvent) => event.event_id));
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((body) => encodedByteLength(body) <= MAX_JOURNEY_INTAKE_BATCH_BODY_BYTES)).toBe(true);
    expect(delivered).toEqual(events.map((event) => event.event_id));
  });

  it("keeps terminal browser deliveries alive while the page unloads", async () => {
    const { exporter, fetchMock } = successfulExporter();

    await exporter([intakeEvent({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" })], { keepalive: true });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ keepalive: true });
  });

  it("rejects an oversized keepalive body before calling fetch", async () => {
    const { exporter, fetchMock } = successfulExporter();
    const oversized = intakeEvent({});

    await expect(exporter([{ ...oversized, attributes: { oversized: "x".repeat(64 * 1024) } }], { keepalive: true })).rejects.toBeInstanceOf(TelemetryPayloadTooLargeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function successfulExporter() {
  const fetchMock = vi.fn(async () => Response.json({ accepted_count: 1, duplicate_count: 0 }, { status: 202 }));
  return { exporter: createJourneyIntakeExporter({ baseUrl: "https://api.chalk.test", fetch: fetchMock as typeof fetch }), fetchMock };
}

function intakeEvent(context: Pick<JourneyIntakeEvent, "traceparent" | "tracestate">): JourneyIntakeEvent {
  return {
    event_id: "00000000-0000-4000-8000-000000000001",
    journey_id: "00000000-0000-4000-8000-000000000002",
    sequence: 1,
    occurred_at: "2026-07-11T00:00:00.000Z",
    name: "journey.started",
    phase: "root",
    state: "started",
    origin_kind: "client",
    first_observed_layer: "client",
    upstream_visibility: "propagated",
    trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
    span_id: "00f067aa0ba902b7",
    ...context,
  };
}

function requestContext(request: RequestInit | undefined) {
  const headers = new Headers(request?.headers);
  return {
    journeyId: headers.get("x-chalk-journey-id"),
    traceparent: headers.get("traceparent"),
    tracestate: headers.get("tracestate"),
  };
}
