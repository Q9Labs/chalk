import { describe, expect, it, vi } from "vitest";
import type { EpisodeDiagnosticsApiClient } from "./api-client";
import { DiagnosticLiveController } from "./live-controller";
import { deltaFixture, eventFixture, snapshotFixture, TEST_FILTER, TEST_FILTER_FINGERPRINT, TEST_REFERENCE } from "./test-fixtures";

const pendingUntilAbort = (signal?: AbortSignal): Promise<void> => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
const eventPage = (events = [] as ReturnType<typeof eventFixture>[], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "DiagnosticEventPage/v1",
  reference: TEST_REFERENCE,
  events,
  committedCursor: 5,
  projectedCursor: 5,
  hasMore: false,
  filterFingerprint: TEST_FILTER_FINGERPRINT,
  ...overrides,
});
const operationPage = (operations: readonly unknown[] = [], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "DiagnosticOperationPage/v1",
  reference: TEST_REFERENCE,
  operations,
  committedCursor: 5,
  projectedCursor: 5,
  hasMore: false,
  filterFingerprint: TEST_FILTER_FINGERPRINT,
  ...overrides,
});
const initialEvidence = () => ({
  readEvents: vi.fn().mockResolvedValue(eventPage()),
  readOperations: vi.fn().mockResolvedValue(operationPage()),
});

const createLiveApi = (overrides: Record<string, unknown> = {}) =>
  ({
    ...initialEvidence(),
    readSnapshot: vi.fn().mockResolvedValue(snapshotFixture(5)),
    ...overrides,
  }) as unknown as EpisodeDiagnosticsApiClient;

const createController = (api: EpisodeDiagnosticsApiClient, options: Partial<Omit<ConstructorParameters<typeof DiagnosticLiveController>[0], "api" | "reference" | "filter">> = {}) =>
  new DiagnosticLiveController({ api, reference: TEST_REFERENCE, filter: TEST_FILTER, onChange: () => undefined, ...options });

const snapshots = (...cursors: number[]) => vi.fn().mockImplementation(() => Promise.resolve(snapshotFixture(cursors.shift() ?? 5)));

const eventPageSequence = (nextPage: ReturnType<typeof eventPage>) => vi.fn().mockResolvedValueOnce(eventPage()).mockResolvedValue(nextPage);

const streamWithDeltas = (...deltas: readonly unknown[]) =>
  async function* (_reference: string, _after: number, _filter: unknown, signal?: AbortSignal) {
    for (const delta of deltas) yield delta;
    await pendingUntilAbort(signal);
  };

const streamWithActivity = async function* (_reference: string, _after: number, _filter: unknown, signal?: AbortSignal, onActivity?: () => void) {
  onActivity?.();
  await pendingUntilAbort(signal);
};

const runController = async (controller: DiagnosticLiveController, waitFor: () => unknown, assertions: () => void | Promise<void> = () => undefined): Promise<void> => {
  const running = controller.start();
  await vi.waitFor(waitFor);
  try {
    await assertions();
  } finally {
    controller.stop();
    await running;
  }
};

const runUntilCursor = (controller: DiagnosticLiveController, cursor: number, assertions: () => void | Promise<void> = () => undefined): Promise<void> => runController(controller, () => expect(controller.getState().lastAppliedCursor).toBe(cursor), assertions);

describe("DiagnosticLiveController", () => {
  it("marks a control-only stream live when transport activity confirms the connection", async () => {
    const controller = createController(createLiveApi({ stream: streamWithActivity }));
    await runController(controller, () => expect(controller.getState().phase).toBe("live"));
  });

  it("starts after the snapshot projected cursor and applies duplicate deltas idempotently", async () => {
    const stream = vi.fn(async function* (_reference, afterCursor: number, _filter, signal?: AbortSignal) {
      expect(afterCursor).toBe(5);
      yield deltaFixture(6);
      yield deltaFixture(6);
      await pendingUntilAbort(signal);
    });
    const controller = createController(createLiveApi({ stream }));
    await runController(
      controller,
      () => expect(controller.getState().lastAppliedCursor).toBe(6),
      () => {
        expect(controller.getState().events).toHaveLength(1);
        expect(controller.getState().phase).toBe("live");
      },
    );
  });

  it("fills a durable cursor gap before applying a later delta", async () => {
    const api = createLiveApi({
      readSnapshot: snapshots(5, 7),
      readEvents: eventPageSequence(
        eventPage([eventFixture(6), eventFixture(7)], {
          committedCursor: 8,
          projectedCursor: 7,
          afterCursor: 5,
          nextCursor: 7,
        }),
      ),
      stream: streamWithDeltas(deltaFixture(8)),
    });
    const controller = createController(api);

    await runUntilCursor(controller, 8, () => {
      expect(api.readEvents).toHaveBeenCalledWith(TEST_REFERENCE, { after: 5, limit: 1_000, filter: TEST_FILTER }, expect.any(AbortSignal));
      expect(controller.getState().events.map((event) => event.cursor)).toEqual([6, 7, 8]);
    });
  });

  it("refuses a reused Event ID with a different fingerprint", async () => {
    const first = deltaFixture(6, eventFixture(6, { eventId: "same-event", fingerprint: "first" }));
    const conflict = deltaFixture(7, eventFixture(7, { eventId: "same-event", fingerprint: "different" }));
    const controller = createController(createLiveApi({ stream: streamWithDeltas(first, conflict) }));
    await runController(
      controller,
      () => expect(controller.getState().error).toContain("different fingerprint"),
      () => expect(controller.getState().error).toContain("different fingerprint"),
    );
  });

  it("refuses mismatched filter fingerprints", async () => {
    const delta = { ...deltaFixture(6), filterFingerprint: "sha256:wrong" };
    const controller = createController(createLiveApi({ stream: streamWithDeltas(delta) }));
    await runController(
      controller,
      () => expect(controller.getState().error).toContain("filter fingerprint"),
      () => expect(controller.getState().error).toContain("filter fingerprint"),
    );
  });

  it("uses the authoritative snapshot cursor when a sparse gap has no visible Events", async () => {
    const api = createLiveApi({
      readSnapshot: snapshots(5, 7),
      readEvents: eventPageSequence(eventPage([], { committedCursor: 7, projectedCursor: 7 })),
      stream: streamWithDeltas(deltaFixture(8)),
    });
    const controller = createController(api);

    await runUntilCursor(controller, 8, () => expect(controller.getState().events.map((event) => event.cursor)).toEqual([8]));
  });

  it("reconnects from the last confirmed cursor after the stream ends", async () => {
    let connections = 0;
    const stream = vi.fn(async function* (_reference: string, afterCursor: number, _filter: unknown, signal?: AbortSignal) {
      connections += 1;
      if (connections === 1) {
        expect(afterCursor).toBe(5);
        yield deltaFixture(6);
        return;
      }
      expect(afterCursor).toBe(6);
      await pendingUntilAbort(signal);
    });
    const api = createLiveApi({
      readSnapshot: vi.fn().mockResolvedValueOnce(snapshotFixture(5)).mockResolvedValue(snapshotFixture(6)),
      stream,
    });
    const controller = createController(api, {
      delay: vi.fn().mockResolvedValue(undefined),
    });

    await runController(
      controller,
      () => expect(stream).toHaveBeenCalledTimes(2),
      () => expect(controller.getState()).toMatchObject({ phase: "reconnecting", lastAppliedCursor: 6, reconnectAttempt: 1 }),
    );
  });

  it("marks a quiet stream stalled without changing the product snapshot", async () => {
    vi.useFakeTimers();
    let currentTime = 0;
    const stream = vi.fn(async function* (_reference: string, _after: number, _filter: unknown, signal?: AbortSignal) {
      await pendingUntilAbort(signal);
    });
    const initialSnapshot = snapshotFixture(5);
    const api = createLiveApi({
      readSnapshot: vi.fn().mockResolvedValue(initialSnapshot),
      stream,
    });
    const controller = createController(api, {
      now: () => currentTime,
      stalledAfterMilliseconds: 5,
    });

    try {
      await runController(
        controller,
        () => expect(stream).toHaveBeenCalledOnce(),
        async () => {
          currentTime = 10;
          await vi.advanceTimersByTimeAsync(1_000);
          expect(controller.getState().phase).toBe("stalled");
          expect(controller.getState().snapshot).toBe(initialSnapshot);
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("enters an explicit recoverable disconnected state after its reconnect budget", async () => {
    const api = createLiveApi({
      stream: async function* () {
        return;
      },
    });
    const controller = createController(api, { maxReconnectAttempts: 0 });

    await controller.start();

    expect(controller.getState()).toMatchObject({ phase: "disconnected", reconnectAttempt: 0 });
  });

  it("refreshes every projection-changing delta without lowering the confirmed cursor", async () => {
    const operation = {
      id: "operation-1",
      kind: "media.connect",
      expectationVersion: 1,
      state: "failed" as const,
      attempt: 1,
      startedAt: "2026-08-04T10:00:00.000Z",
      checkpoints: [],
      source: "sdk" as const,
    };
    const refreshed = snapshotFixture(6, {
      operations: [operation],
      run: {
        schemaVersion: "RunProjection/v1",
        state: "live",
        startedAt: "2026-08-04T10:00:00.000Z",
        elapsedMilliseconds: 6_000,
        participantCount: 1,
        activeOperationCount: 0,
        openIssueCount: 1,
        participantLanes: [],
      },
    });
    const api = createLiveApi({
      readSnapshot: vi.fn().mockResolvedValueOnce(snapshotFixture(5)).mockResolvedValue(refreshed),
      stream: streamWithDeltas({ ...deltaFixture(6), kind: "operation_updated" as const, event: undefined, operation }),
    });
    const controller = createController(api);

    await runController(
      controller,
      () => expect(controller.getState().snapshot?.run?.elapsedMilliseconds).toBe(6_000),
      () => {
        expect(api.readSnapshot).toHaveBeenCalledTimes(2);
        expect(controller.getState().lastAppliedCursor).toBe(6);
        expect(controller.getState().operations).toContainEqual(operation);
      },
    );
  });

  it("preserves a gap delta as visible evidence while refilling through its authoritative cursor", async () => {
    const gapPage = eventPage([eventFixture(6), eventFixture(7)], { committedCursor: 7, projectedCursor: 7, afterCursor: 5 });
    const gapDelta = {
      schemaVersion: "DiagnosticStreamDelta/v1" as const,
      reference: TEST_REFERENCE,
      cursor: 6,
      kind: "gap" as const,
      filterFingerprint: TEST_FILTER_FINGERPRINT,
      gap: { fromCursor: 6, toCursor: 7, reason: "not_observable" },
    };
    const api = createLiveApi({
      readSnapshot: snapshots(5, 7),
      readEvents: eventPageSequence(gapPage),
      stream: streamWithDeltas(gapDelta),
    });
    const controller = createController(api);

    await runController(
      controller,
      () => expect(controller.getState().lastAppliedCursor).toBe(7),
      () => {
        expect(controller.getState().visibleGaps).toEqual([{ fromCursor: 6, toCursor: 7, reason: "not_observable" }]);
        expect(controller.getState().events.map((event) => event.cursor)).toEqual([6, 7]);
      },
    );
  });

  it("refreshes a snapshot marker without reporting a visibility gap or paging Events", async () => {
    const refreshDelta = {
      schemaVersion: "DiagnosticStreamDelta/v1" as const,
      reference: TEST_REFERENCE,
      cursor: 6,
      kind: "gap" as const,
      filterFingerprint: TEST_FILTER_FINGERPRINT,
      gap: { fromCursor: 6, toCursor: 6, reason: "snapshot_refresh" },
    };
    const api = createLiveApi({
      readSnapshot: snapshots(5, 6),
      stream: streamWithDeltas(refreshDelta),
    });
    const controller = createController(api);

    await runUntilCursor(controller, 6, () => {
      expect(api.readSnapshot).toHaveBeenCalledTimes(2);
      expect(api.readEvents).toHaveBeenCalledOnce();
      expect(controller.getState().visibleGaps).toEqual([]);
      expect(controller.getState().phase).toBe("live");
    });
  });
});
