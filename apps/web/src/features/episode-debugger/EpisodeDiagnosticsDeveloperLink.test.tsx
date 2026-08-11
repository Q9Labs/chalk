// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpisodeDiagnosticsAvailabilityClient } from "./EpisodeDiagnosticsDeveloperLink";
import { EpisodeDiagnosticsDeveloperLink } from "./EpisodeDiagnosticsDeveloperLink";
import { TEST_REFERENCE } from "./test-fixtures";

afterEach(cleanup);

describe("EpisodeDiagnosticsDeveloperLink", () => {
  it("is absent when diagnostics are compile-gated off", () => {
    const { container } = render(<EpisodeDiagnosticsDeveloperLink diagnosticReference={TEST_REFERENCE} enabled={false} />);
    expect(container.childElementCount).toBe(0);
  });

  it("links an authoritative canonical Diagnostic Reference", () => {
    render(<EpisodeDiagnosticsDeveloperLink diagnosticReference={TEST_REFERENCE} enabled />);
    expect(screen.getByRole("link", { name: "Inspect diagnostics" }).getAttribute("href")).toContain(encodeURIComponent(TEST_REFERENCE));
  });

  it("waits for an Episode alternate reference to be available before linking", async () => {
    const episodeReference = "chalk.episode:33333333-3333-4333-8333-333333333333";
    const api = { resolveAlternate: vi.fn().mockResolvedValue(TEST_REFERENCE) } as unknown as EpisodeDiagnosticsAvailabilityClient;
    render(<EpisodeDiagnosticsDeveloperLink diagnosticReference={episodeReference} enabled api={api} />);

    expect(screen.getByRole("status").textContent).toContain("Checking Episode Debugger availability");
    const link = await screen.findByRole("link", { name: "Inspect diagnostics" });
    expect(link.getAttribute("href")).toContain(encodeURIComponent(episodeReference));
    expect(api.resolveAlternate).toHaveBeenCalledWith(episodeReference, expect.any(AbortSignal));
  });

  it("does not link unavailable diagnostics and retries on request", async () => {
    const episodeReference = "chalk.episode:44444444-4444-4444-8444-444444444444";
    const resolveAlternate = vi.fn().mockRejectedValue(new Error("not found"));
    const api = { resolveAlternate } as unknown as EpisodeDiagnosticsAvailabilityClient;
    render(<EpisodeDiagnosticsDeveloperLink diagnosticReference={episodeReference} enabled api={api} />);

    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toContain("Episode Debugger unavailable."), { timeout: 3_000 });
    expect(screen.queryByRole("link", { name: "Inspect diagnostics" })).toBeNull();

    resolveAlternate.mockResolvedValue(TEST_REFERENCE);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "Inspect diagnostics" })).toBeTruthy());
    expect(resolveAlternate).toHaveBeenCalledTimes(4);
  });
});
