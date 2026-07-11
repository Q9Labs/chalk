import { describe, expect, it, vi } from "vitest";
import { NORMAL_FLUSH_DELAY_MS, TelemetryDelivery } from "./delivery";
import { createJourneyIntakeExporter, encodedByteLength, journeyIntakeBody, MAX_KEEPALIVE_BODY_BYTES, TelemetryExportError, type TelemetryExporter } from "./exporter";
import type { TelemetryStorage } from "./storage";
import type { TelemetryEvent } from "./types";

describe("TelemetryDelivery", () => {
  it("batches normal events emitted across event-loop turns", async () => {
    vi.useFakeTimers();
    try {
      const exporter = vi.fn().mockResolvedValue({ accepted_count: 2, duplicate_count: 0 });
      const delivery = normalBatchDelivery(exporter);

      delivery.enqueue(event("first"));
      await vi.advanceTimersByTimeAsync(0);
      delivery.enqueue(event("second"));
      await vi.advanceTimersByTimeAsync(NORMAL_FLUSH_DELAY_MS - 1);

      expect(exporter).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(exporter).toHaveBeenCalledOnce();
      expect(exporter.mock.calls[0]?.[0].map((item) => item.event_id)).toEqual(["first", "second"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a full normal batch without waiting for the batching window", async () => {
    vi.useFakeTimers();
    try {
      const exporter = vi.fn().mockResolvedValue({ accepted_count: 3, duplicate_count: 0 });
      const delivery = normalBatchDelivery(exporter);

      delivery.enqueue(event("first"));
      delivery.enqueue(event("second"));
      delivery.enqueue(event("third"));
      await vi.advanceTimersByTimeAsync(0);

      expect(exporter).toHaveBeenCalledOnce();
      expect(exporter.mock.calls[0]?.[0].map((item) => item.event_id)).toEqual(["first", "second", "third"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes explicitly without waiting for the normal batching window", async () => {
    await withPendingNormalEvent(async (delivery, exporter) => {
      await delivery.flush();
      await vi.advanceTimersByTimeAsync(NORMAL_FLUSH_DELAY_MS);

      expect(exporter).toHaveBeenCalledOnce();
      expect(exporter.mock.calls[0]?.[0].map((item) => item.event_id)).toEqual(["first"]);
    });
  });

  it("cancels a pending normal batch when disposed", async () => {
    await withPendingNormalEvent(async (delivery, exporter) => {
      delivery.dispose();
      await vi.advanceTimersByTimeAsync(NORMAL_FLUSH_DELAY_MS);

      expect(exporter).not.toHaveBeenCalled();
    });
  });

  it("keeps the newest events and signals dropped work", async () => {
    const onDrop = vi.fn();
    const delivery = new TelemetryDelivery({ batchSize: 2, enabled: true, maxQueueSize: 1, maxTimelineEntries: 2, onDrop, retryDelayMs: 100 });
    delivery.enqueue(event("first"));
    delivery.enqueue(event("second"));
    await Promise.resolve();

    expect(delivery.getPendingEvents().map((item) => item.event_id)).toEqual(["second"]);
    expect(delivery.getHealth()).toMatchObject({ droppedEvents: 1, queueDepth: 1 });
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it("does not evict an in-flight batch or discard newer events after export", async () => {
    let releaseFirstExport: (() => void) | undefined;
    const firstExport = new Promise<void>((resolve) => {
      releaseFirstExport = resolve;
    });
    const exported: string[][] = [];
    const exporter = vi.fn(async (batch: readonly { event_id: string }[]) => {
      exported.push(batch.map((item) => item.event_id));
      if (exported.length === 1) await firstExport;
    });
    const onDrop = vi.fn();
    const delivery = new TelemetryDelivery({ batchSize: 2, enabled: true, exporter, maxQueueSize: 3, maxTimelineEntries: 4, onDrop, retryDelayMs: 100 });
    delivery.enqueue(event("first"));
    delivery.enqueue(event("second"));
    delivery.enqueue(event("third"));
    await vi.waitFor(() => expect(exporter).toHaveBeenCalledOnce());

    delivery.enqueue(event("fourth"));
    expect(delivery.getPendingEvents().map((item) => item.event_id)).toEqual(["first", "second", "fourth"]);
    releaseFirstExport?.();
    await delivery.flush();

    expect(exported).toEqual([["first", "second"], ["fourth"]]);
    expect(delivery.getPendingEvents()).toEqual([]);
    expect(delivery.getHealth()).toMatchObject({ droppedEvents: 1, exportedEvents: 3, queueDepth: 0 });
    expect(onDrop).toHaveBeenCalledWith([expect.objectContaining({ event_id: "third" })]);
  });

  it("merges restored events before the first persistence write", async () => {
    let releaseLoad: ((events: readonly TelemetryEvent[]) => void) | undefined;
    const load = new Promise<readonly TelemetryEvent[]>((resolve) => {
      releaseLoad = resolve;
    });
    const save = vi.fn(async () => undefined);
    const storage: TelemetryStorage = { load: () => load, save };
    const delivery = new TelemetryDelivery({ batchSize: 2, enabled: true, maxQueueSize: 3, maxTimelineEntries: 4, retryDelayMs: 100, storage });

    delivery.enqueue(event("new"));
    releaseLoad?.([event("restored")]);
    await delivery.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());

    expect(save.mock.calls[0]?.[0].map((item) => item.event_id)).toEqual(["restored", "new"]);
    expect(delivery.getPendingEvents().map((item) => item.event_id)).toEqual(["restored", "new"]);
  });

  it("delivers restored and concurrent parent-child events in correlation-compatible requests", async () => {
    let restore: ((events: readonly TelemetryEvent[]) => void) | undefined;
    const storage: TelemetryStorage = {
      load: () => new Promise<readonly TelemetryEvent[]>((resolve) => (restore = resolve)),
      save: async () => undefined,
    };
    const fetchMock = vi.fn(async () => Response.json({ accepted_count: 1, duplicate_count: 0 }, { status: 202 }));
    const exporter = createJourneyIntakeExporter({ baseUrl: "https://api.chalk.test", fetch: fetchMock as typeof fetch });
    const delivery = new TelemetryDelivery({ batchSize: 3, enabled: true, exporter, maxQueueSize: 8, maxTimelineEntries: 8, retryDelayMs: 100, storage });
    const parent = journeyContext("00000000-0000-4000-8000-000000000001", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const child = journeyContext("00000000-0000-4000-8000-000000000002", "00-4bf92f3577b34da6a3ce929d0e0e4736-0af7651916cd43dd-01");

    delivery.enqueue(eventWithContext("concurrent-parent", parent));
    delivery.enqueue(eventWithContext("concurrent-child", child));
    restore?.([eventWithContext("restored-parent", parent), eventWithContext("restored-child", child)]);
    await delivery.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestContext(fetchMock.mock.calls[0]?.[1])).toEqual(parent);
    expect(requestEvents(fetchMock.mock.calls[0]?.[1])).toEqual(["restored-parent", "concurrent-parent"]);
    expect(requestContext(fetchMock.mock.calls[1]?.[1])).toEqual(child);
    expect(requestEvents(fetchMock.mock.calls[1]?.[1])).toEqual(["restored-child", "concurrent-child"]);
  });

  it("reports restored events discarded by the queue bound", async () => {
    const onDrop = vi.fn();
    const storage: TelemetryStorage = {
      load: async () => [event("oldest"), event("older"), event("newest")],
      save: async () => undefined,
    };
    const delivery = new TelemetryDelivery({ batchSize: 2, enabled: true, maxQueueSize: 2, maxTimelineEntries: 4, onDrop, retryDelayMs: 100, storage });

    await delivery.flush();
    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledOnce());

    expect(delivery.getPendingEvents().map((item) => item.event_id)).toEqual(["older", "newest"]);
    expect(delivery.getHealth()).toMatchObject({ droppedEvents: 1, queueDepth: 2, status: "idle" });
    expect(onDrop).toHaveBeenCalledWith([expect.objectContaining({ event_id: "oldest" })]);
  });

  it("discards a permanently rejected batch and continues with newer events", async () => {
    const exporter = vi.fn().mockRejectedValueOnce(new TelemetryExportError(400)).mockResolvedValueOnce({ accepted_count: 1, duplicate_count: 0 });
    const onDrop = vi.fn();
    const delivery = new TelemetryDelivery({ batchSize: 1, enabled: true, exporter, maxQueueSize: 3, maxTimelineEntries: 4, onDrop, retryDelayMs: 100 });
    delivery.enqueue(event("invalid"));
    delivery.enqueue(event("valid"));

    await delivery.flush();

    expect(exporter).toHaveBeenCalledTimes(2);
    expect(delivery.getPendingEvents()).toEqual([]);
    expect(delivery.getHealth()).toMatchObject({ droppedEvents: 1, exportedEvents: 1, failedBatches: 1, queueDepth: 0 });
    expect(onDrop).toHaveBeenCalledWith([expect.objectContaining({ event_id: "invalid" })]);
  });

  it("does not schedule another export when disposed during a failed batch", async () => {
    vi.useFakeTimers();
    let rejectExport: ((error: Error) => void) | undefined;
    let markExportStarted: (() => void) | undefined;
    const exportStarted = new Promise<void>((resolve) => {
      markExportStarted = resolve;
    });
    const exporter = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectExport = reject;
          markExportStarted?.();
        }),
    );
    const delivery = new TelemetryDelivery({ batchSize: 1, enabled: true, exporter, maxQueueSize: 3, maxTimelineEntries: 4, retryDelayMs: 10 });

    delivery.enqueue(event("slow-failure"));
    const activeFlush = delivery.flush();
    await exportStarted;
    expect(exporter).toHaveBeenCalledOnce();
    delivery.dispose();
    rejectExport?.(new TelemetryExportError(503));
    await activeFlush;
    await vi.advanceTimersByTimeAsync(100);

    expect(exporter).toHaveBeenCalledOnce();
    expect(delivery.getPendingEvents().map((item) => item.event_id)).toEqual(["slow-failure"]);
    vi.useRealTimers();
  });

  it("holds newly enqueued events until a scheduled retry is due", async () => {
    vi.useFakeTimers();
    const exporter = vi.fn().mockRejectedValueOnce(new TelemetryExportError(503)).mockResolvedValue({ accepted_count: 2, duplicate_count: 0 });
    const delivery = new TelemetryDelivery({ batchSize: 2, enabled: true, exporter, maxQueueSize: 3, maxTimelineEntries: 4, retryDelayMs: 100 });

    delivery.enqueue(event("first"));
    await delivery.flush();
    delivery.enqueue(event("second"));
    await Promise.resolve();

    expect(exporter).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(99);
    expect(exporter).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(exporter).toHaveBeenCalledTimes(2);
    expect(delivery.getPendingEvents()).toEqual([]);
    vi.useRealTimers();
  });

  it("prioritizes the newest terminal event in a standalone keepalive batch", async () => {
    const exporter = vi.fn().mockRejectedValueOnce(new TelemetryExportError(503)).mockResolvedValue({ accepted_count: 1, duplicate_count: 0 });
    const delivery = new TelemetryDelivery({ batchSize: 1, enabled: true, exporter, maxQueueSize: 4, maxTimelineEntries: 4, retryDelayMs: 10_000 });
    delivery.enqueue(event("oldest"));
    delivery.enqueue(event("middle"));
    await delivery.flush();
    delivery.enqueue(terminalEvent("terminal"));

    await delivery.flush({ keepalive: true });

    expect(exporter.mock.calls[1]).toEqual([[expect.objectContaining({ event_id: "terminal", name: "journey.terminal" })], { keepalive: true }]);
  });

  it("keeps the newest child terminal prioritized without mixing its parent context", async () => {
    const exporter = vi.fn().mockRejectedValueOnce(new TelemetryExportError(503)).mockResolvedValue({ accepted_count: 2, duplicate_count: 0 });
    const delivery = new TelemetryDelivery({ batchSize: 4, enabled: true, exporter, maxQueueSize: 8, maxTimelineEntries: 8, retryDelayMs: 10_000 });
    const parent = journeyContext("00000000-0000-4000-8000-000000000001", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const child = journeyContext("00000000-0000-4000-8000-000000000002", "00-4bf92f3577b34da6a3ce929d0e0e4736-0af7651916cd43dd-01");
    delivery.enqueue(eventWithContext("parent-start", parent));
    delivery.enqueue(eventWithContext("child-start", child));
    delivery.enqueue(eventWithContext("parent-phase", parent));
    delivery.enqueue({ ...eventWithContext("child-terminal", child), name: "journey.terminal", phase: "terminal", state: "succeeded" });

    await delivery.flush();
    await delivery.flush({ keepalive: true });

    expect(exporter.mock.calls[1]).toEqual([[expect.objectContaining({ event_id: "child-start", journey_id: child.journeyId }), expect.objectContaining({ event_id: "child-terminal", journey_id: child.journeyId, name: "journey.terminal" })], { keepalive: true }]);
  });

  it("reserves a keepalive batch while a normal batch completes", async () => {
    let releaseNormal: (() => void) | undefined;
    let releaseKeepalive: (() => void) | undefined;
    const exporter = vi.fn((batch: readonly { event_id: string }[], options?: { keepalive?: boolean }) => {
      if (options?.keepalive) return new Promise<void>((resolve) => (releaseKeepalive = resolve));
      return new Promise<void>((resolve) => (releaseNormal = resolve));
    });
    const delivery = new TelemetryDelivery({ batchSize: 1, enabled: true, exporter, maxQueueSize: 4, maxTimelineEntries: 4, retryDelayMs: 100 });
    delivery.enqueue(event("normal"));
    await vi.waitFor(() => expect(exporter).toHaveBeenCalledOnce());
    delivery.enqueue(terminalEvent("terminal"));
    const keepalive = delivery.flush({ keepalive: true });
    await vi.waitFor(() => expect(exporter).toHaveBeenCalledTimes(2));

    releaseNormal?.();
    await Promise.resolve();
    expect(exporter).toHaveBeenCalledTimes(2);
    releaseKeepalive?.();
    await keepalive;

    expect(exporter.mock.calls.map(([batch]) => batch.map((item: { event_id: string }) => item.event_id))).toEqual([["normal"], ["terminal"]]);
    expect(delivery.getHealth()).toMatchObject({ exportedEvents: 2, queueDepth: 0 });
  });

  it("re-sends an active normal batch with stable IDs during a keepalive flush", async () => {
    let releaseNormal: (() => void) | undefined;
    const exporter = vi.fn(async (batch: readonly { event_id: string }[], options?: { keepalive?: boolean }) => {
      if (!options?.keepalive) await new Promise<void>((resolve) => (releaseNormal = resolve));
      return { accepted_count: batch.length, duplicate_count: 0 };
    });
    const delivery = new TelemetryDelivery({ batchSize: 1, enabled: true, exporter, maxQueueSize: 4, maxTimelineEntries: 4, retryDelayMs: 100 });
    delivery.enqueue(event("in-flight"));
    await vi.waitFor(() => expect(exporter).toHaveBeenCalledOnce());

    await delivery.flush({ keepalive: true });

    expect(exporter.mock.calls.map(([batch, options]) => [batch.map((item) => item.event_id), options])).toEqual([
      [["in-flight"], undefined],
      [["in-flight"], { keepalive: true }],
    ]);
    expect(delivery.getPendingEvents()).toEqual([]);
    expect(delivery.getHealth()).toMatchObject({ exportedEvents: 1, queueDepth: 0 });

    releaseNormal?.();
    await delivery.flush();

    expect(delivery.getHealth()).toMatchObject({ exportedEvents: 1, queueDepth: 0 });
  });

  it("dispatches a terminal batch while an earlier keepalive request is active", async () => {
    let releaseFirstKeepalive: (() => void) | undefined;
    const exporter = vi
      .fn()
      .mockRejectedValueOnce(new TelemetryExportError(503))
      .mockImplementationOnce(() => new Promise<void>((resolve) => (releaseFirstKeepalive = resolve)))
      .mockResolvedValue({ accepted_count: 1, duplicate_count: 0 });
    const delivery = new TelemetryDelivery({ batchSize: 1, enabled: true, exporter, maxQueueSize: 4, maxTimelineEntries: 4, retryDelayMs: 10_000 });
    delivery.enqueue(event("hidden-page"));
    await delivery.flush();
    const hiddenFlush = delivery.flush({ keepalive: true });
    await vi.waitFor(() => expect(exporter).toHaveBeenCalledTimes(2));

    delivery.enqueue(terminalEvent("pagehide-terminal"));
    await delivery.flush({ keepalive: true });

    expect(exporter).toHaveBeenCalledTimes(3);
    expect(exporter.mock.calls[2]).toEqual([[expect.objectContaining({ event_id: "pagehide-terminal", name: "journey.terminal" })], { keepalive: true }]);
    releaseFirstKeepalive?.();
    await hiddenFlush;
    expect(delivery.getPendingEvents()).toEqual([]);
  });

  it("keeps an attribute-heavy unload batch below the browser keepalive quota", async () => {
    const exporter = vi.fn().mockRejectedValueOnce(new TelemetryExportError(503)).mockResolvedValue({ accepted_count: 1, duplicate_count: 0 });
    const delivery = new TelemetryDelivery({ batchSize: 25, enabled: true, exporter, maxQueueSize: 30, maxTimelineEntries: 30, retryDelayMs: 10_000 });
    for (let index = 0; index < 24; index += 1) delivery.enqueue(heavyEvent(`heavy-${index}`));
    await delivery.flush();
    delivery.enqueue(terminalEvent("terminal"));

    await delivery.flush({ keepalive: true });

    const [batch, options] = exporter.mock.calls[1] ?? [];
    expect(options).toEqual({ keepalive: true });
    expect(batch.at(-1)).toMatchObject({ event_id: "terminal", name: "journey.terminal" });
    expect(encodedByteLength(journeyIntakeBody(batch))).toBeLessThanOrEqual(MAX_KEEPALIVE_BODY_BYTES);
  });
});

function event(eventId: string): TelemetryEvent {
  return {
    version: 1,
    event_id: eventId,
    journey_id: "00000000-0000-4000-8000-000000000001",
    sequence: 1,
    occurred_at: "2026-07-11T00:00:00.000Z",
    name: "journey.started",
    phase: "root",
    state: "started",
    origin_kind: "client",
    first_observed_layer: "client",
    upstream_visibility: "local",
  };
}

function terminalEvent(eventId: string): TelemetryEvent {
  return {
    ...event(eventId),
    name: "journey.terminal",
    phase: "terminal",
    state: "succeeded",
  };
}

function heavyEvent(eventId: string): TelemetryEvent {
  return {
    ...event(eventId),
    attributes: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`attribute_${index}`, "x".repeat(256)])),
  };
}

function eventWithContext(eventId: string, context: ReturnType<typeof journeyContext>): TelemetryEvent {
  return { ...event(eventId), journey_id: context.journeyId, traceparent: context.traceparent, tracestate: context.tracestate };
}

function journeyContext(journeyId: string, traceparent: string) {
  return { journeyId, traceparent, tracestate: "chalk=local" };
}

function requestContext(request: RequestInit | undefined) {
  const headers = new Headers(request?.headers);
  return Object.fromEntries(
    [
      ["journeyId", "x-chalk-journey-id"],
      ["traceparent", "traceparent"],
      ["tracestate", "tracestate"],
    ].map(([key, header]) => [key, headers.get(header)]),
  );
}

function requestEvents(request: RequestInit | undefined): string[] {
  return JSON.parse(String(request?.body)).events.map((item: { event_id: string }) => item.event_id);
}

function normalBatchDelivery(exporter: TelemetryExporter): TelemetryDelivery {
  return new TelemetryDelivery({ batchSize: 3, enabled: true, exporter, maxQueueSize: 3, maxTimelineEntries: 3, retryDelayMs: 100 });
}

async function withFakeTimers(test: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await test();
  } finally {
    vi.useRealTimers();
  }
}

async function withPendingNormalEvent(test: (delivery: TelemetryDelivery, exporter: ReturnType<typeof vi.fn>) => Promise<void>): Promise<void> {
  await withFakeTimers(async () => {
    const exporter = vi.fn().mockResolvedValue({ accepted_count: 1, duplicate_count: 0 });
    const delivery = normalBatchDelivery(exporter);
    delivery.enqueue(event("first"));
    await test(delivery, exporter);
  });
}
