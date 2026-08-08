// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusPage, parseStatusSummary } from "./StatusPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const summary = {
  schema_version: 1,
  generated_at: "2026-08-08T12:00:00Z",
  overall: "degraded",
  components: [
    {
      id: "web",
      name: "Web",
      description: "Chalk web application",
      state: "operational",
      checked_at: "2026-08-08T11:59:00Z",
      last_changed_at: "2026-08-08T11:50:00Z",
    },
    {
      id: "api",
      name: "API",
      description: "Chalk control plane API",
      state: "degraded",
      checked_at: null,
      last_changed_at: null,
    },
  ],
};

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function stalledFetcher(onSignal: (signal: AbortSignal) => void) {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) throw new Error("missing abort signal");
    onSignal(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
}

describe("StatusPage", () => {
  it("loads an accessible public summary and renders only the safe contract", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe("omit");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      return response({ ...summary, private_monitor_key: "do-not-render", target_url: "https://private.example" });
    });

    render(<StatusPage fetcher={fetcher} pollIntervalMs={60_000} />);
    expect(screen.getByRole("status").textContent).toContain("Loading current status");
    expect(await screen.findByRole("heading", { name: "Overall status", level: 2 })).toBeTruthy();
    expect(screen.getAllByText("Degraded")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Web", level: 3 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "API", level: 3 })).toBeTruthy();
    expect(screen.getAllByText("Not available")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
    expect(screen.queryByText("do-not-render")).toBeNull();
    expect(screen.queryByText("https://private.example")).toBeNull();
  });

  it("shows unavailable on the first failure and recovers through manual refresh", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ error: "private failure" }, 503))
      .mockResolvedValueOnce(response({ ...summary, overall: "operational" }));
    render(<StatusPage fetcher={fetcher} pollIntervalMs={60_000} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Status unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getAllByText("Operational")).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the last summary and announces a failed later update", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(summary))
      .mockResolvedValueOnce(response({ error: "temporary" }, 503));
    render(<StatusPage fetcher={fetcher} pollIntervalMs={20} />);
    await screen.findByRole("heading", { name: "Overall status", level: 2 });
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(screen.getByText("The latest update failed. Showing the last known status.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "API", level: 3 })).toBeTruthy();
  });

  it("polls on the monitor cadence", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(response(summary));
    render(<StatusPage fetcher={fetcher} pollIntervalMs={5 * 60 * 1000} />);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled request and shows unavailable after the deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetcher = stalledFetcher((signal) => {
      requestSignal = signal;
    });
    render(<StatusPage fetcher={fetcher} pollIntervalMs={60_000} requestTimeoutMs={50} />);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(requestSignal?.aborted).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Status unavailable");
  });

  it("aborts an active request when the page unmounts", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetcher = stalledFetcher((signal) => {
      requestSignal = signal;
    });
    const page = render(<StatusPage fetcher={fetcher} pollIntervalMs={60_000} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    page.unmount();

    expect(requestSignal?.aborted).toBe(true);
  });
});

describe("parseStatusSummary", () => {
  it("rejects malformed or private-shaped status responses", () => {
    expect(parseStatusSummary(summary)).toMatchObject({ schema_version: 1, overall: "degraded" });
    expect(() => parseStatusSummary({ ...summary, overall: "private" })).toThrow("invalid status response");
    expect(() => parseStatusSummary({ ...summary, components: [{ ...summary.components[0], checked_at: "not-a-time" }] })).toThrow("invalid status response");
  });
});
