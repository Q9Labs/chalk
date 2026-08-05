// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardEpisode } from "../../lib/dashboard-api";
import { durationLabel, formatDateTime, formatJSON, humanizeReason, messageForError, readSearchParam, statusLabel, updateSearch } from "./episode-utils";

function episode(overrides: Partial<DashboardEpisode> = {}): DashboardEpisode {
  return {
    id: "episode-1",
    tenant_id: "tenant-1",
    space_id: "space-1",
    status: "ended",
    metadata: {},
    config_snapshot: {},
    end_reason: null,
    started_at: "2026-08-04T09:00:00Z",
    ended_at: "2026-08-04T09:42:00Z",
    deadline_at: "2026-08-04T11:00:00Z",
    deadline_generation: 0,
    updated_at: "2026-08-04T09:42:00Z",
    created_at: "2026-08-04T09:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/episodes?space=space-1");
});

describe("episode URL helpers", () => {
  it("reads and updates filters without losing the current path", () => {
    expect(readSearchParam("space")).toBe("space-1");
    const pushState = vi.spyOn(window.history, "pushState");

    updateSearch({ space: null, episode: "episode-1" });

    expect(pushState).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe("/episodes");
    expect(window.location.search).toBe("?episode=episode-1");
    expect(readSearchParam("space")).toBeNull();
    expect(readSearchParam("episode")).toBe("episode-1");
    pushState.mockRestore();
  });
});

describe("episode formatting helpers", () => {
  it("labels each lifecycle status and humanizes end reasons", () => {
    expect(statusLabel("active")).toBe("Live now");
    expect(statusLabel("ending")).toBe("Ending");
    expect(statusLabel("ended")).toBe("Ended");
    expect(humanizeReason("deadline_exceeded")).toBe("Deadline Exceeded");
  });

  it("formats missing, invalid, and valid timestamps", () => {
    expect(formatDateTime(null)).toBe("Not recorded");
    expect(formatDateTime("not-a-timestamp")).toBe("Unknown time");
    expect(formatDateTime("2026-08-04T09:00:00Z")).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-08-04T09:00:00Z")));
  });

  it("distinguishes live history, short runs, and measured durations", () => {
    expect(durationLabel(episode({ ended_at: null }))).toBe("History");
    expect(durationLabel(episode({ ended_at: "2026-08-04T09:00:15Z" }))).toBe("Less than a minute");
    expect(durationLabel(episode())).toBe("42 min");
  });

  it("serializes snapshots and reports circular values safely", () => {
    expect(formatJSON(null)).toBe("No values recorded");
    expect(formatJSON({ source: "test" })).toBe('{\n  "source": "test"\n}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatJSON(circular)).toBe("Values unavailable");
  });
});

describe("messageForError", () => {
  it("maps auth, access, throttling, and service failures to safe copy", () => {
    expect(messageForError({ status: 401 }, "fallback")).toContain("sign-in has expired");
    expect(messageForError({ status: 403 }, "fallback")).toBe("You do not have access to this Episode history.");
    expect(messageForError({ status: 429 }, "fallback")).toContain("rate-limiting");
    expect(messageForError({ status: 503 }, "fallback")).toContain("service is unavailable");
  });

  it("preserves useful errors and falls back for unknown causes", () => {
    expect(messageForError(new Error("request failed"), "fallback")).toBe("request failed");
    expect(messageForError({ message: "bad request" }, "fallback")).toBe("bad request");
    expect(messageForError({ detail: "unknown" }, "fallback")).toBe("fallback");
    expect(messageForError("bad request", "fallback")).toBe("fallback");
  });
});
