// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CallPageDTO } from "../../lib/dashboard/contracts";
import { AdmissionKnocks } from "./AdmissionKnocks";

const pending: CallPageDTO["knocks"][number] = { handle: "request-1", name: "June", requestedAt: "2026-10-21T00:00:00Z", expiresAt: "2026-10-21T00:05:00Z", state: "pending", decisionState: "none", decisionAction: null };
afterEach(cleanup);

describe("server-owned admission decisions", () => {
  it("makes an accepted decision busy, then restores retry after Sync fails it", () => {
    const decide = vi.fn(async () => {});
    const view = render(<AdmissionKnocks knocks={[pending]} onDecision={decide} />);
    fireEvent.click(screen.getByRole("button", { name: "Let in", exact: true }));
    expect(decide).toHaveBeenCalledTimes(1);
    view.rerender(<AdmissionKnocks knocks={[{ ...pending, decisionState: "in_flight", decisionAction: "approve" }]} onDecision={decide} />);
    const busy = screen.getByRole<HTMLButtonElement>("button", { name: "Letting in…", exact: true });
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(decide).toHaveBeenCalledTimes(1);
    // The next authoritative list always wins, even after the click was accepted.
    view.rerender(<AdmissionKnocks knocks={[{ ...pending, decisionState: "retryable" }]} onDecision={decide} />);
    const retry = screen.getByRole<HTMLButtonElement>("button", { name: "Let in", exact: true });
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    expect(decide).toHaveBeenCalledTimes(2);
    view.rerender(<AdmissionKnocks knocks={[]} onDecision={decide} />);
    expect(screen.queryByText("June")).toBeNull();
  });

  it("shows server-owned in-flight denials with both actions disabled", () => {
    render(<AdmissionKnocks knocks={[{ ...pending, decisionState: "in_flight", decisionAction: "deny" }]} onDecision={async () => {}} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Denying…" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Let in", exact: true }).disabled).toBe(true);
  });
});
