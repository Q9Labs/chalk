// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphView, RunView } from "./RunGraphViews";
import { snapshotFixture } from "./test-fixtures";

afterEach(cleanup);

describe("RunGraphViews", () => {
  it("pages graph nodes while preserving edge selection for a visible node", () => {
    const onSelect = vi.fn();
    const nodes = Array.from({ length: 13 }, (_, index) => ({ id: `node-${index}`, kind: "sdk" as const, label: `System ${index}`, state: "healthy" as const, operationCount: 0, issueCount: 0 }));
    const edge = { id: "edge-12", from: "node-12", to: "node-0", state: "active" as const, operationIds: [], issueIds: [] };
    render(<GraphView snapshot={snapshotFixture(8, { graph: { schemaVersion: "GraphProjection/v1", nodes, edges: [edge], summary: { nodeCount: nodes.length, edgeCount: 1, activeCount: 1, failedCount: 0, unobservableCount: 0 } } })} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Next nodes" }));
    fireEvent.click(screen.getByRole("button", { name: /System 12/ }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "edge", value: edge });
  });

  it("shows the explicit whiteboard v1 boundary in the Run projection", () => {
    render(
      <RunView
        snapshot={snapshotFixture(8, {
          run: { schemaVersion: "RunProjection/v1", state: "live", startedAt: "2026-08-04T10:00:00.000Z", elapsedMilliseconds: 1_000, participantCount: 0, activeOperationCount: 0, openIssueCount: 0, participantLanes: [] },
        })}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Whiteboard diagnostics are unsupported in v1")).toBeTruthy();
  });
});
