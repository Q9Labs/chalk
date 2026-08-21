// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useConnection } from "../bindings/hooks";
import { useEpisodeDuration } from "./useEpisodeDuration";

vi.mock("../bindings/hooks", () => ({ useConnection: vi.fn() }));

const mockedUseConnection = vi.mocked(useConnection);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-21T12:00:05.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useEpisodeDuration", () => {
  it("reports elapsed Episode seconds and refreshes once per second", () => {
    mockedUseConnection.mockReturnValue({ status: "live", episode: { id: "episode-1", startedAt: "2026-08-21T12:00:00.000Z", deadline: null }, lastError: null });

    const { result } = renderHook(() => useEpisodeDuration());
    expect(result.current).toBe(5);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(result.current).toBe(7);
  });

  it("returns zero when there is no valid Episode start", () => {
    mockedUseConnection.mockReturnValue({ status: "live", episode: { id: "episode-1", startedAt: null, deadline: null }, lastError: null });

    const { result } = renderHook(() => useEpisodeDuration());
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current).toBe(0);
  });
});
