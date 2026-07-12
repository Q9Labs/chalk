import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NORMAL_FLUSH_DELAY_MS, type TelemetryDeliveryEffectService } from "./delivery";
import { encodedByteLength, journeyIntakeBody, MAX_KEEPALIVE_BODY_BYTES, TelemetryExportError } from "./exporter";
import { makeDeliveryHarness, makeScriptedExporter, makeScriptedStorage, type DeliveryHarness } from "./test-support";
import type { TelemetryEvent } from "./types";

const harnesses: DeliveryHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

describe("TelemetryDeliveryService", () => {
  it("batches normal events emitted across event-loop turns with TestClock", async () => {
    const exporter = makeScriptedExporter();
    const harness = deliveryHarness(exporter);
    await harness.ready();

    await enqueue(harness.delivery, event("first"));
    await harness.settle();
    await enqueue(harness.delivery, event("second"));
    await harness.adjust(NORMAL_FLUSH_DELAY_MS - 1);

    expect(exporter.calls).toEqual([]);
    await harness.adjust(1);

    expect(exporter.calls.map(exportedIds)).toEqual([["first", "second"]]);
  });

  it("flushes a full normal batch without advancing TestClock", async () => {
    const exporter = makeScriptedExporter();
    const harness = deliveryHarness(exporter);
    await harness.ready();

    await enqueue(harness.delivery, event("first"));
    await enqueue(harness.delivery, event("second"));
    const flushNow = harness.delivery.enqueueUnsafe(event("third"));
    await harness.run(flushNow ? harness.delivery.flush() : harness.delivery.persist());

    expect(exporter.calls.map(exportedIds)).toEqual([["first", "second", "third"]]);
  });

  it("flushes explicitly without advancing the normal batching window", async () => {
    const exporter = makeScriptedExporter();
    const harness = deliveryHarness(exporter);
    await harness.ready();
    await enqueue(harness.delivery, event("first"));

    await harness.run(harness.delivery.flush());
    await harness.adjust(NORMAL_FLUSH_DELAY_MS);

    expect(exporter.calls.map(exportedIds)).toEqual([["first"]]);
  });

  it("cancels a pending normal batch when the service is disposed", async () => {
    const exporter = makeScriptedExporter();
    const harness = deliveryHarness(exporter);
    await harness.ready();
    await enqueue(harness.delivery, event("first"));

    await harness.run(harness.delivery.dispose());
    await harness.adjust(NORMAL_FLUSH_DELAY_MS);

    expect(exporter.calls).toEqual([]);
  });

  it("keeps the newest events and signals dropped work", async () => {
    const onDrop = vi.fn();
    const harness = deliveryHarness(makeScriptedExporter(), { maxQueueSize: 1, onDrop });
    await harness.ready();

    await enqueue(harness.delivery, event("first"));
    await enqueue(harness.delivery, event("second"));

    expect(harness.delivery.getPendingEventsUnsafe().map((item) => item.event_id)).toEqual(["second"]);
    expect(harness.delivery.getHealthUnsafe()).toMatchObject({ droppedEvents: 1, queueDepth: 1 });
    expect(onDrop).toHaveBeenCalledWith([expect.objectContaining({ event_id: "first" })]);
  });

  it("does not evict an in-flight batch or discard newer events after export", async () => {
    const exporter = makeScriptedExporter();
    const releaseFirstExport = exporter.waitNext();
    const onDrop = vi.fn();
    const harness = deliveryHarness(exporter, { batchSize: 2, maxQueueSize: 3, onDrop });
    await harness.ready();

    await enqueue(harness.delivery, event("first"));
    await enqueue(harness.delivery, event("second"));
    const activeFlush = harness.run(harness.delivery.flush());
    await harness.settle();
    await enqueue(harness.delivery, event("third"));
    await enqueue(harness.delivery, event("fourth"));

    expect(harness.delivery.getPendingEventsUnsafe().map((item) => item.event_id)).toEqual(["first", "second", "fourth"]);
    releaseFirstExport();
    await activeFlush;
    await harness.run(harness.delivery.flush());

    expect(exporter.calls.map(exportedIds)).toEqual([["first", "second"], ["fourth"]]);
    expect(harness.delivery.getPendingEventsUnsafe()).toEqual([]);
    expect(harness.delivery.getHealthUnsafe()).toMatchObject({ droppedEvents: 1, exportedEvents: 3, queueDepth: 0 });
    expect(onDrop).toHaveBeenCalledWith([expect.objectContaining({ event_id: "third" })]);
  });

  it("merges restored events before the first persistence write", async () => {
    const storage = makeScriptedStorage({ waitForLoad: true });
    const harness = deliveryHarness(makeScriptedExporter(), {}, storage);

    await enqueue(harness.delivery, event("new"));
    storage.resolveLoad([event("restored")]);
    await harness.ready();

    expect(storage.saves[0]?.map((item) => item.event_id)).toEqual(["restored", "new"]);
    expect(harness.delivery.getPendingEventsUnsafe().map((item) => item.event_id)).toEqual(["restored", "new"]);
  });

  it("delivers restored and concurrent parent-child events in correlation-compatible batches", async () => {
    const exporter = makeScriptedExporter();
    const storage = makeScriptedStorage({ waitForLoad: true });
    const harness = deliveryHarness(exporter, { batchSize: 8, maxQueueSize: 8, maxTimelineEntries: 8 }, storage);
    const parent = journeyContext("00000000-0000-4000-8000-000000000001", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const child = journeyContext("00000000-0000-4000-8000-000000000002", "00-4bf92f3577b34da6a3ce929d0e0e4736-0af7651916cd43dd-01");

    await enqueue(harness.delivery, eventWithContext("concurrent-parent", parent));
    await enqueue(harness.delivery, eventWithContext("concurrent-child", child));
    storage.resolveLoad([eventWithContext("restored-parent", parent), eventWithContext("restored-child", child)]);
    await harness.ready();
    await harness.run(harness.delivery.flush());

    expect(exporter.calls.map(exportedIds)).toEqual([
      ["restored-parent", "concurrent-parent"],
      ["restored-child", "concurrent-child"],
    ]);
    expect(exporter.calls.map((call) => call.events[0]?.journey_id)).toEqual([parent.journeyId, child.journeyId]);
    expect(exporter.calls.map((call) => call.events[0]?.traceparent)).toEqual([parent.traceparent, child.traceparent]);
  });

  it("reports restored events discarded by the queue bound", async () => {
    const onDrop = vi.fn();
    const storage = makeScriptedStorage({ load: [event("oldest"), event("older"), event("newest")] });
    const harness = deliveryHarness(makeScriptedExporter(), { maxQueueSize: 2, onDrop }, storage);
    await harness.ready();

    expect(harness.delivery.getPendingEventsUnsafe().map((item) => item.event_id)).toEqual(["older", "newest"]);
    expect(harness.delivery.getHealthUnsafe()).toMatchObject({ droppedEvents: 1, queueDepth: 2, status: "idle" });
    expect(onDrop).toHaveBeenCalledWith([expect.objectContaining({ event_id: "oldest" })]);
  });

  it("discards a permanently rejected batch and continues with newer events", async () => {
    const exporter = makeScriptedExporter();
    exporter.failNext(new TelemetryExportError(400), false);
    const onDrop = vi.fn();
    const harness = deliveryHarness(exporter, { batchSize: 1, onDrop });
    await harness.ready();
    await enqueue(harness.delivery, event("invalid"));
    await enqueue(harness.delivery, event("valid"));

    await harness.run(harness.delivery.flush());

    expect(exporter.calls.map(exportedIds)).toEqual([["invalid"], ["valid"]]);
    expect(harness.delivery.getPendingEventsUnsafe()).toEqual([]);
    expect(harness.delivery.getHealthUnsafe()).toMatchObject({ droppedEvents: 1, exportedEvents: 1, failedBatches: 1, queueDepth: 0 });
    expect(onDrop).toHaveBeenCalledWith([expect.objectContaining({ event_id: "invalid" })]);
  });

  it("does not schedule another export when disposed during a failed batch", async () => {
    const exporter = makeScriptedExporter();
    const releaseFailure = exporter.waitNext({ cause: new TelemetryExportError(503), retriable: true });
    const harness = deliveryHarness(exporter, { batchSize: 1, retryDelayMs: 10 });
    await harness.ready();
    await enqueue(harness.delivery, event("slow-failure"));

    const activeFlush = harness.run(harness.delivery.flush());
    await harness.settle();
    await harness.run(harness.delivery.dispose());
    releaseFailure();
    await activeFlush;
    await harness.adjust(100);

    expect(exporter.calls.map(exportedIds)).toEqual([["slow-failure"]]);
    expect(harness.delivery.getPendingEventsUnsafe().map((item) => item.event_id)).toEqual(["slow-failure"]);
  });

  it("holds newly enqueued events until a TestClock-scheduled retry is due", async () => {
    const exporter = makeScriptedExporter();
    exporter.failNext(new TelemetryExportError(503), true);
    const harness = deliveryHarness(exporter, { batchSize: 2, retryDelayMs: 100 });
    await harness.ready();
    await enqueue(harness.delivery, event("first"));

    await harness.run(harness.delivery.flush());
    await enqueue(harness.delivery, event("second"));
    await harness.adjust(99);

    expect(exporter.calls.map(exportedIds)).toEqual([["first"]]);
    await harness.adjust(1);

    expect(exporter.calls.map(exportedIds)).toEqual([["first"], ["first", "second"]]);
    expect(harness.delivery.getPendingEventsUnsafe()).toEqual([]);
  });

  it("prioritizes the newest terminal event in a standalone keepalive batch", async () => {
    const exporter = makeScriptedExporter();
    exporter.failNext(new TelemetryExportError(503), true);
    const harness = deliveryHarness(exporter, { batchSize: 1, retryDelayMs: 10_000 });
    await harness.ready();
    await enqueue(harness.delivery, event("oldest"));
    await enqueue(harness.delivery, event("middle"));
    await harness.run(harness.delivery.flush());
    await enqueue(harness.delivery, terminalEvent("terminal"));

    await harness.run(harness.delivery.flush({ keepalive: true }));

    expect(exporter.calls[1]).toMatchObject({ events: [expect.objectContaining({ event_id: "terminal", name: "journey.terminal" })], options: { keepalive: true } });
  });

  it("keeps the newest child terminal prioritized without mixing its parent context", async () => {
    const exporter = makeScriptedExporter();
    exporter.failNext(new TelemetryExportError(503), true);
    const harness = deliveryHarness(exporter, { batchSize: 4, maxQueueSize: 8, maxTimelineEntries: 8, retryDelayMs: 10_000 });
    await harness.ready();
    const parent = journeyContext("00000000-0000-4000-8000-000000000001", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    const child = journeyContext("00000000-0000-4000-8000-000000000002", "00-4bf92f3577b34da6a3ce929d0e0e4736-0af7651916cd43dd-01");
    await enqueue(harness.delivery, eventWithContext("parent-start", parent));
    await enqueue(harness.delivery, eventWithContext("child-start", child));
    await enqueue(harness.delivery, eventWithContext("parent-phase", parent));
    await enqueue(harness.delivery, { ...eventWithContext("child-terminal", child), name: "journey.terminal", phase: "terminal", state: "succeeded" });

    await harness.run(harness.delivery.flush());
    await harness.run(harness.delivery.flush({ keepalive: true }));

    expect(exporter.calls[1]).toMatchObject({
      events: [expect.objectContaining({ event_id: "child-start", journey_id: child.journeyId }), expect.objectContaining({ event_id: "child-terminal", journey_id: child.journeyId, name: "journey.terminal" })],
      options: { keepalive: true },
    });
  });

  it("reserves a keepalive batch while a normal batch completes", async () => {
    const exporter = makeScriptedExporter();
    const releaseNormal = exporter.waitNext();
    const releaseKeepalive = exporter.waitNext();
    const harness = deliveryHarness(exporter, { batchSize: 1 });
    await harness.ready();
    await enqueue(harness.delivery, event("normal"));

    const normalFlush = harness.run(harness.delivery.flush());
    await harness.settle();
    await enqueue(harness.delivery, terminalEvent("terminal"));
    const keepaliveFlush = harness.run(harness.delivery.flush({ keepalive: true }));
    await harness.settle();
    releaseNormal();
    await normalFlush;

    expect(exporter.calls.map(exportedIds)).toEqual([["normal"], ["terminal"]]);
    releaseKeepalive();
    await keepaliveFlush;
    expect(harness.delivery.getHealthUnsafe()).toMatchObject({ exportedEvents: 2, queueDepth: 0 });
  });

  it("re-sends an active normal batch with stable IDs during a keepalive flush", async () => {
    const exporter = makeScriptedExporter();
    const releaseNormal = exporter.waitNext();
    const harness = deliveryHarness(exporter, { batchSize: 1 });
    await harness.ready();
    await enqueue(harness.delivery, event("in-flight"));

    const normalFlush = harness.run(harness.delivery.flush());
    await harness.settle();
    await harness.run(harness.delivery.flush({ keepalive: true }));

    expect(exporter.calls.map((call) => [exportedIds(call), call.options])).toEqual([
      [["in-flight"], undefined],
      [["in-flight"], { keepalive: true }],
    ]);
    expect(harness.delivery.getPendingEventsUnsafe()).toEqual([]);
    expect(harness.delivery.getHealthUnsafe()).toMatchObject({ exportedEvents: 1, queueDepth: 0 });

    releaseNormal();
    await normalFlush;
    await harness.run(harness.delivery.flush());
    expect(harness.delivery.getHealthUnsafe()).toMatchObject({ exportedEvents: 1, queueDepth: 0 });
  });

  it("dispatches a terminal batch while an earlier keepalive request is active", async () => {
    const exporter = makeScriptedExporter();
    exporter.failNext(new TelemetryExportError(503), true);
    const releaseFirstKeepalive = exporter.waitNext();
    const harness = deliveryHarness(exporter, { batchSize: 1, retryDelayMs: 10_000 });
    await harness.ready();
    await enqueue(harness.delivery, event("hidden-page"));
    await harness.run(harness.delivery.flush());

    const hiddenFlush = harness.run(harness.delivery.flush({ keepalive: true }));
    await harness.settle();
    await enqueue(harness.delivery, terminalEvent("pagehide-terminal"));
    await harness.run(harness.delivery.flush({ keepalive: true }));

    expect(exporter.calls.map(exportedIds)).toEqual([["hidden-page"], ["hidden-page"], ["pagehide-terminal"]]);
    expect(exporter.calls[2]).toMatchObject({ options: { keepalive: true }, events: [expect.objectContaining({ name: "journey.terminal" })] });
    releaseFirstKeepalive();
    await hiddenFlush;
    expect(harness.delivery.getPendingEventsUnsafe()).toEqual([]);
  });

  it("keeps an attribute-heavy unload batch below the browser keepalive quota", async () => {
    const exporter = makeScriptedExporter();
    exporter.failNext(new TelemetryExportError(503), true);
    const harness = deliveryHarness(exporter, { batchSize: 25, maxQueueSize: 30, maxTimelineEntries: 30, retryDelayMs: 10_000 });
    await harness.ready();
    for (let index = 0; index < 24; index += 1) await enqueue(harness.delivery, heavyEvent(`heavy-${index}`));
    await harness.run(harness.delivery.flush());
    await enqueue(harness.delivery, terminalEvent("terminal"));

    await harness.run(harness.delivery.flush({ keepalive: true }));

    const batch = exporter.calls[1]?.events ?? [];
    expect(exporter.calls[1]?.options).toEqual({ keepalive: true });
    expect(batch.at(-1)).toMatchObject({ event_id: "terminal", name: "journey.terminal" });
    expect(encodedByteLength(journeyIntakeBody(batch))).toBeLessThanOrEqual(MAX_KEEPALIVE_BODY_BYTES);
  });
});

function deliveryHarness(exporter: ReturnType<typeof makeScriptedExporter>, overrides: Partial<Parameters<typeof makeDeliveryHarness>[0]> = {}, storage = makeScriptedStorage()): DeliveryHarness {
  const harness = makeDeliveryHarness({ batchSize: 3, enabled: true, maxQueueSize: 3, maxTimelineEntries: 3, retryDelayMs: 100, ...overrides }, exporter, storage);
  harnesses.push(harness);
  return harness;
}

function enqueue(delivery: TelemetryDeliveryEffectService, item: TelemetryEvent): Promise<void> {
  return Effect.runPromise(delivery.enqueue(item));
}

function exportedIds(call: { readonly events: readonly { readonly event_id: string }[] }): string[] {
  return call.events.map((item) => item.event_id);
}

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
  return { ...event(eventId), name: "journey.terminal", phase: "terminal", state: "succeeded" };
}

function heavyEvent(eventId: string): TelemetryEvent {
  return { ...event(eventId), attributes: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`attribute_${index}`, "x".repeat(256)])) };
}

function eventWithContext(eventId: string, context: ReturnType<typeof journeyContext>): TelemetryEvent {
  return { ...event(eventId), journey_id: context.journeyId, traceparent: context.traceparent, tracestate: context.tracestate };
}

function journeyContext(journeyId: string, traceparent: string) {
  return { journeyId, traceparent, tracestate: "chalk=local" };
}
