// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpisodeDiagnosticsApiClient } from "./api-client";
import { EpisodeDebuggerScreen } from "./EpisodeDebuggerScreen";
import { snapshotFixture, TEST_FILTER_FINGERPRINT, TEST_REFERENCE } from "./test-fixtures";

afterEach(cleanup);

describe("EpisodeDebuggerScreen", () => {
  it("refuses a disabled diagnostics build before constructing the API client", () => {
    render(<EpisodeDebuggerScreen reference={TEST_REFERENCE} mode="off" />);

    expect(screen.getByRole("heading", { name: "Episode Diagnostics are off" })).toBeTruthy();
    expect(screen.getByText("This build does not register the debugger route when diagnostics mode is off.")).toBeTruthy();
  });

  it("labels a zero-evidence reference inactive without claiming a positive state", async () => {
    const api = {
      readSnapshot: vi.fn().mockResolvedValue(snapshotFixture(0)),
      readEvents: vi.fn().mockResolvedValue({ schemaVersion: "DiagnosticEventPage/v1", reference: TEST_REFERENCE, events: [], committedCursor: 0, projectedCursor: 0, hasMore: false, filterFingerprint: TEST_FILTER_FINGERPRINT }),
      readOperations: vi.fn().mockResolvedValue({ schemaVersion: "DiagnosticOperationPage/v1", reference: TEST_REFERENCE, operations: [], committedCursor: 0, projectedCursor: 0, hasMore: false, filterFingerprint: TEST_FILTER_FINGERPRINT }),
      stream: vi.fn(async function* (_reference: string, _cursor: number, _filter: unknown, signal?: AbortSignal) {
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      }),
    } as unknown as EpisodeDiagnosticsApiClient;

    const { container } = render(<EpisodeDebuggerScreen reference={TEST_REFERENCE} api={api} mode="localhost" />);

    expect(await screen.findByRole("heading", { name: "Evidence unavailable" })).toBeTruthy();
    expect(screen.getByText(/Evidence is inactive/)).toBeTruthy();
    expect(container.querySelector('[data-episode-evidence-state="inactive"]')).toBeTruthy();
    expect(screen.queryByText(/healthy|successful|success/i)).toBeNull();
  });
});
