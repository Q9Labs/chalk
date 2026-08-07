// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailsPanel } from "./DetailsPanel";
import { snapshotFixture } from "./test-fixtures";

afterEach(cleanup);

describe("DetailsPanel", () => {
  it("shows branch evidence and copies its registered diagnostic reference", () => {
    const onCopy = vi.fn();
    const branch = {
      id: "branch-artifact",
      reference: "chalkdiag:v1:localhost:diag_fixture:branch:branch-artifact@8",
      kind: "artifact" as const,
      state: "succeeded" as const,
      leaseEndsAt: "2026-08-04T10:05:00.000Z",
      startedAt: "2026-08-04T10:00:00.000Z",
      terminalAt: "2026-08-04T10:00:02.000Z",
      terminalCursor: 8,
      attempts: 2,
      lateObservations: 1,
    };

    render(<DetailsPanel snapshot={snapshotFixture(8, { branches: [branch] })} selection={{ kind: "branch", value: branch }} onCopy={onCopy} onSelect={vi.fn()} onOpenRelated={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "artifact" })).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy branch reference" }));
    expect(onCopy).toHaveBeenCalledWith(branch.reference, "Branch reference");
  });
});
