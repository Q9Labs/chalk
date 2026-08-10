// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticStreamDeltaV1 } from "@q9labsai/diagnostics-contracts";
import type { EpisodeDiagnosticsApiClient } from "./api-client";
import { buildFilter, EpisodeDebuggerScreen } from "./EpisodeDebuggerScreen";
import { eventFixture, snapshotFixture, TEST_FILTER_FINGERPRINT, TEST_REFERENCE } from "./test-fixtures";

afterEach(cleanup);

const operation = {
  id: "operation-1",
  reference: `${TEST_REFERENCE}:op:operation-1@8`,
  kind: "screen.start",
  expectationVersion: 1,
  state: "stalled" as const,
  attempt: 1,
  startedAt: "2026-08-04T10:00:00.000Z",
  checkpoints: [],
  source: "sdk" as const,
};
const issue = { id: "issue-1", reference: `${TEST_REFERENCE}:issue:issue-1@8`, kind: "checkpoint_missing", severity: "error" as const, state: "open" as const, summary: "Remote frame missing", firstObservedAt: "2026-08-04T10:00:01.000Z", operationId: operation.id };
const branch = { id: "branch-1", kind: "cleanup" as const, state: "running" as const, leaseEndsAt: "2026-08-04T10:05:00.000Z", attempts: 1 };

const completeSnapshot = snapshotFixture(8, {
  summary: { eventCount: 1, operationCount: 1, issueCount: 1, openIssueCount: 1, participantCount: 1 },
  operations: [operation],
  issues: [issue],
  branches: [branch],
  participants: [
    {
      schemaVersion: "ParticipantProjection/v1",
      participantId: "participant-1",
      anonymousLabel: "Participant 1",
      identityKind: "guest",
      state: "joined",
      visibility: "observable",
      visibilityGaps: [],
      operationCount: 1,
      issueCount: 1,
      display: { label: { value: "Participant 1" }, rawIdentity: { unknownReason: "not_retained" } },
    },
  ],
  run: { schemaVersion: "RunProjection/v1", state: "live", startedAt: "2026-08-04T10:00:00.000Z", elapsedMilliseconds: 8_000, participantCount: 1, activeOperationCount: 1, openIssueCount: 1, participantLanes: [{ participantId: "participant-1", operationIds: [operation.id], state: "joined" }] },
  graph: {
    schemaVersion: "GraphProjection/v1",
    nodes: [
      { id: "sdk", kind: "sdk", label: "Client SDK", state: "stalled", operationCount: 1, issueCount: 1 },
      { id: "sfu", kind: "sfu", label: "SFU", state: "unobservable", operationCount: 1, issueCount: 1 },
    ],
    edges: [{ id: "sdk-sfu", from: "sdk", to: "sfu", state: "stalled", operationIds: [operation.id], issueIds: [issue.id] }],
    summary: { nodeCount: 2, edgeCount: 1, activeCount: 0, failedCount: 0, unobservableCount: 1 },
  },
  flame: { schemaVersion: "FlameProjection/v1", lanes: [{ id: "sdk", label: "Client SDK", source: "sdk", bars: [{ id: "bar-1", operationId: operation.id, startAt: operation.startedAt, endAt: "2026-08-04T10:00:01.000Z", state: "stalled" }] }], buckets: [], heat: [] },
  epilogue: { schemaVersion: "EpilogueProjection/v1", state: "live", branches: [branch], openBranchCount: 1, terminalBranchCount: 0 },
});

const pendingStream = async function* (_reference: string, _cursor: number, _filter: unknown, signal?: AbortSignal) {
  await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
};

const appApi = (snapshot = completeSnapshot) =>
  ({
    readSnapshot: vi.fn().mockResolvedValue(snapshot),
    readEvents: vi.fn().mockResolvedValue({ schemaVersion: "DiagnosticEventPage/v1", reference: TEST_REFERENCE, events: [eventFixture(8)], committedCursor: 8, projectedCursor: 8, hasMore: false, filterFingerprint: TEST_FILTER_FINGERPRINT }),
    readOperations: vi.fn().mockResolvedValue({ schemaVersion: "DiagnosticOperationPage/v1", reference: TEST_REFERENCE, operations: [operation], committedCursor: 8, projectedCursor: 8, hasMore: false, filterFingerprint: TEST_FILTER_FINGERPRINT }),
    stream: vi.fn(pendingStream),
  }) as unknown as EpisodeDiagnosticsApiClient;

describe("EpisodeDebuggerScreen", () => {
  it("renders the real bounded app fixture with seven labeled views and stable operator actions", async () => {
    const { container } = render(<EpisodeDebuggerScreen reference={TEST_REFERENCE} api={appApi()} mode="localhost" />);
    await screen.findByRole("region", { name: "Run view" });

    for (const view of ["run", "graph", "trace", "flame", "issues", "participants", "epilogue"]) {
      const button = container.querySelector(`[data-episode-view="${view}"]`);
      expect(button).toBeTruthy();
      fireEvent.click(button!);
      expect(screen.getByRole("region", { name: `${view === "epilogue" ? "Epilogue" : `${view[0]?.toUpperCase()}${view.slice(1)}`} view` })).toBeTruthy();
    }
    for (const action of ["copy-all", "copy-agent", "download-json", "copy-reference"]) expect(container.querySelector(`[data-episode-action="${action}"]`)).toBeTruthy();
    expect(container.querySelector("main.episode-debugger[data-chalk][data-episode-stream-state]")).toBeTruthy();
  });

  it("shows failed evidence explicitly and retries through a fresh controller", async () => {
    const api = appApi() as unknown as { readSnapshot: ReturnType<typeof vi.fn> };
    api.readSnapshot.mockReset().mockRejectedValueOnce(new Error("gateway unavailable")).mockResolvedValue(completeSnapshot);
    const { container } = render(<EpisodeDebuggerScreen reference={TEST_REFERENCE} api={api as unknown as EpisodeDiagnosticsApiClient} mode="localhost" />);

    await screen.findAllByText("gateway unavailable");
    expect(container.querySelector('main[data-episode-stream-state="failed"]')).toBeTruthy();
    expect(container.querySelector('[data-episode-action="retry-stream"]')).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry evidence" })[0]!);

    await waitFor(() => expect(api.readSnapshot).toHaveBeenCalledTimes(2));
    await screen.findByText("Participant lanes");
  });

  it("projects a concrete stream gap through the stable tooling hook", async () => {
    const gapApi = appApi() as unknown as EpisodeDiagnosticsApiClient & { readSnapshot: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn> };
    gapApi.readSnapshot
      .mockReset()
      .mockResolvedValueOnce(completeSnapshot)
      .mockResolvedValue({ ...completeSnapshot, committedCursor: 9, projectedCursor: 9 });
    gapApi.stream = vi.fn(async function* (_reference: string, _cursor: number, _filter: unknown, signal?: AbortSignal) {
      const gap: DiagnosticStreamDeltaV1 = { schemaVersion: "DiagnosticStreamDelta/v1", reference: TEST_REFERENCE, cursor: 9, kind: "gap", filterFingerprint: TEST_FILTER_FINGERPRINT, gap: { fromCursor: 9, toCursor: 9, reason: "telemetry_gap" } };
      yield gap;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    });
    const { container } = render(<EpisodeDebuggerScreen reference={TEST_REFERENCE} api={gapApi} mode="localhost" />);

    await waitFor(() => expect(container.querySelector("[data-episode-gap]")).toBeTruthy());
    expect(container.querySelector('main[data-episode-stream-state="live"]')).toBeTruthy();
    expect(screen.getByText(/Preserved visibility gap 9–9/)).toBeTruthy();
  });

  it("builds a bounded around-time filter and rejects inverted cursor windows", () => {
    expect(buildFilter({ aroundTime: "2026-08-04T10:00:00.000Z", aroundSeconds: "30" })).toMatchObject({ fromTime: "2026-08-04T09:59:30.000Z", toTime: "2026-08-04T10:00:30.000Z" });
    expect(() => buildFilter({ fromCursor: "9", toCursor: "4" })).toThrow("cursor window");
  });

  it("resolves alternate IDs before loading the canonical Episode", async () => {
    const api = appApi() as unknown as EpisodeDiagnosticsApiClient & { resolveAlternate: ReturnType<typeof vi.fn> };
    api.resolveAlternate = vi.fn().mockResolvedValue(TEST_REFERENCE);

    render(<EpisodeDebuggerScreen reference="chalk.journey:journey01" api={api} mode="localhost" />);

    expect(screen.getByText("Resolving Diagnostic Reference")).toBeTruthy();
    await screen.findByText("Participant lanes");
    expect(api.resolveAlternate).toHaveBeenCalledWith("chalk.journey:journey01", expect.any(AbortSignal));
    expect(screen.getAllByTitle(TEST_REFERENCE).some((element) => element.tagName === "CODE" && element.textContent === TEST_REFERENCE)).toBe(true);
  });
});
