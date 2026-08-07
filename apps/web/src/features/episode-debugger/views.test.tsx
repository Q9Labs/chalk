// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailsPanel } from "./DetailsPanel";
import { IssuesView } from "./EntityViews";
import { GraphView } from "./RunGraphViews";
import { FlameView, TraceView } from "./TraceFlameViews";
import { eventFixture, snapshotFixture } from "./test-fixtures";

afterEach(cleanup);

const operation = {
  schemaVersion: "OperationDetail/v1" as const,
  id: "operation-1",
  kind: "screen.start",
  expectationVersion: 1,
  state: "stalled" as const,
  attempt: 2,
  startedAt: "2026-08-04T10:00:00.000Z",
  deadlineAt: "2026-08-04T10:00:01.000Z",
  durationMilliseconds: 1_250,
  checkpoints: [
    { key: "permission", class: "required" as const, displayOrder: 0, state: "observed" as const, evidenceCursor: 4 },
    { key: "remote_first_frame", class: "conditional" as const, displayOrder: 1, state: "not_observable" as const, unknownReason: "not_observable" as const },
  ],
  source: "sdk" as const,
  requestId: { idClass: "chalk.request", value: "request-1", copyable: true },
  providerId: { idClass: "provider", unknownReason: "not_retained" as const, copyable: false },
};

describe("accessible diagnostic alternatives", () => {
  it("renders paged operation and Event hierarchy with timing and evidence relationships", () => {
    const hierarchicalOperation = { ...operation, retryGroup: { idClass: "chalk.retry", value: "retry-1", copyable: true }, clockUncertainty: "50ms", checkpoints: [{ key: "connected", class: "required" as const, displayOrder: 0, state: "observed" as const, evidenceCursor: 8 }] };
    const event = eventFixture(8);
    const snapshot = snapshotFixture(8, { operations: [hierarchicalOperation], summary: { eventCount: 20, operationCount: 12, issueCount: 0, openIssueCount: 0 } });
    const onLoadMoreEvents = vi.fn();
    const { container } = render(
      <TraceView
        snapshot={snapshot}
        operations={[hierarchicalOperation]}
        events={[event]}
        eventPage={{ hasMore: true, loading: false, loadedCount: 1, capacity: 1_000 }}
        operationPage={{ hasMore: true, loading: false, loadedCount: 1, capacity: 1_000 }}
        onSelect={vi.fn()}
        onLoadMoreEvents={onLoadMoreEvents}
        onLoadMoreOperations={vi.fn()}
      />,
    );

    expect(screen.getByText(/Showing 1 of 20 Events/)).toBeTruthy();
    expect(screen.getByText(/clock 50ms/)).toBeTruthy();
    expect(screen.getByText(/received .* cursor 8/)).toBeTruthy();
    expect(container.querySelectorAll(".episode-trace-tree-row")[1]?.getAttribute("style")).toContain("16px");
    fireEvent.click(screen.getByRole("button", { name: "Load more Events" }));
    expect(onLoadMoreEvents).toHaveBeenCalledOnce();
  });

  it("offers a keyboard-operable table alternative for the causal graph", () => {
    const onSelect = vi.fn();
    const snapshot = snapshotFixture(8, {
      graph: {
        schemaVersion: "GraphProjection/v1",
        nodes: [
          { id: "sdk", kind: "sdk", label: "Client SDK", state: "stalled", operationCount: 1, issueCount: 1 },
          { id: "sfu", kind: "sfu", label: "SFU", state: "unobservable", operationCount: 1, issueCount: 1 },
        ],
        edges: [{ id: "sdk-sfu", from: "sdk", to: "sfu", state: "stalled", operationIds: ["operation-1"], issueIds: ["issue-1"] }],
        summary: { nodeCount: 2, edgeCount: 1, activeCount: 0, failedCount: 0, unobservableCount: 1 },
      },
    });
    render(<GraphView snapshot={snapshot} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Table alternative" }));
    fireEvent.click(screen.getByRole("button", { name: "1 operations" }));

    expect(screen.getByRole("table", { name: "Causal diagnostic graph edges" })).toBeTruthy();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: "edge" }));
  });

  it("offers a table alternative for the waterfall without losing selection", () => {
    const onSelect = vi.fn();
    const snapshot = snapshotFixture(8, {
      operations: [operation],
      flame: {
        schemaVersion: "FlameProjection/v1",
        lanes: [{ id: "sdk", label: "Client SDK", source: "sdk", bars: [{ id: "bar-1", operationId: "operation-1", startAt: operation.startedAt, endAt: "2026-08-04T10:00:01.250Z", state: "stalled", attempt: 2 }] }],
        buckets: [],
        heat: [],
      },
    });
    render(<FlameView snapshot={snapshot} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Table alternative" }));
    fireEvent.click(screen.getByRole("button", { name: "screen.start" }));

    expect(screen.getByRole("table", { name: "Operation waterfall table alternative" })).toBeTruthy();
    expect(onSelect).toHaveBeenCalledWith({ kind: "operation", value: operation });
  });
});

describe("typed details", () => {
  it("shows affected issue context without exposing an HMAC identifier", () => {
    const affectedIssue = {
      id: "issue-affected",
      kind: "provider_timeout",
      severity: "warning" as const,
      state: "open" as const,
      summary: "Provider did not confirm",
      firstObservedAt: "2026-08-04T10:00:00.000Z",
      affected: { kind: "service" as const, identifier: { idClass: "provider", value: "raw-provider-identifier", copyable: false } },
      diagnosticReference: "chalkdiag:v1:localhost:diag_fixture:issue:issue-affected@8",
    };
    render(<IssuesView snapshot={snapshotFixture(8, { issues: [affectedIssue] })} onSelect={vi.fn()} />);

    expect(screen.getByText("service: unknown: opaque identifier omitted")).toBeTruthy();
    expect(screen.queryByText("raw-provider-identifier")).toBeNull();
    expect(screen.getByText(affectedIssue.diagnosticReference)).toBeTruthy();
  });

  it("renders every promised operation field and protects non-copyable IDs", () => {
    const onCopy = vi.fn();
    const snapshot = snapshotFixture(8, { operations: [operation] });
    render(<DetailsPanel snapshot={snapshot} selection={{ kind: "operation", value: operation }} onCopy={onCopy} onSelect={vi.fn()} onOpenRelated={vi.fn()} />);

    expect(screen.getByText("Checkpoints")).toBeTruthy();
    expect(screen.getByText("remote_first_frame")).toBeTruthy();
    expect(screen.getByText("unknown: opaque identifier omitted")).toBeTruthy();
    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    expect(copyButtons.some((button) => button.hasAttribute("disabled"))).toBe(true);
  });

  it("never displays or copies an unregistered raw provider identifier", () => {
    const unsafeOperation = { ...operation, providerId: "raw-provider-identifier" };
    render(<DetailsPanel snapshot={snapshotFixture(8, { operations: [unsafeOperation] })} selection={{ kind: "operation", value: unsafeOperation }} onCopy={vi.fn()} onSelect={vi.fn()} onOpenRelated={vi.fn()} />);

    expect(screen.queryByText("raw-provider-identifier")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Copy" }).some((button) => button.hasAttribute("disabled"))).toBe(true);
  });

  it("opens issue and edge evidence from the persistent details feed", () => {
    const onSelect = vi.fn();
    const issue = { id: "issue-1", kind: "checkpoint_missing", severity: "error" as const, state: "open" as const, summary: "Remote frame missing", firstObservedAt: "2026-08-04T10:00:00.000Z", operationId: operation.id };
    const snapshot = snapshotFixture(8, { operations: [operation], issues: [issue], summary: { eventCount: 8, operationCount: 1, issueCount: 1, openIssueCount: 1 } });
    const edge = { id: "sdk-sfu", state: "failed", operationIds: [operation.id], issueIds: [issue.id] };
    const { rerender } = render(<DetailsPanel snapshot={snapshot} onCopy={vi.fn()} onSelect={onSelect} onOpenRelated={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Remote frame missing/ }));
    rerender(<DetailsPanel snapshot={snapshot} selection={{ kind: "edge", value: edge }} onCopy={vi.fn()} onSelect={onSelect} onOpenRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open screen.start" }));

    expect(onSelect).toHaveBeenCalledWith({ kind: "issue", value: issue });
    expect(onSelect).toHaveBeenCalledWith({ kind: "operation", value: operation });
  });
});
