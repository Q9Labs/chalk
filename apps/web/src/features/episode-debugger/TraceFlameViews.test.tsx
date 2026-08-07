// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlameView, TraceView } from "./TraceFlameViews";
import { snapshotFixture } from "./test-fixtures";

afterEach(cleanup);

describe("TraceFlameViews", () => {
  it("reports an omitted Flame projection instead of implying complete evidence", () => {
    render(<FlameView snapshot={snapshotFixture(8)} onSelect={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Flame projection unavailable" })).toBeTruthy();
    expect(screen.getByText("The server did not include a bounded FlameProjection/v1.")).toBeTruthy();
  });

  it("keeps an empty trace bounded and explains where evidence will arrive", () => {
    render(
      <TraceView
        snapshot={snapshotFixture(8)}
        operations={[]}
        events={[]}
        eventPage={{ hasMore: true, loading: false, loadedCount: 0, capacity: 100 }}
        operationPage={{ hasMore: true, loading: false, loadedCount: 0, capacity: 100 }}
        selection={undefined}
        onSelect={vi.fn()}
        onLoadMoreEvents={vi.fn()}
        onLoadMoreOperations={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "No trace evidence" })).toBeTruthy();
  });
});
