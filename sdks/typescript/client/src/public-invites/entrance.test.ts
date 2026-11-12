import { describe, expect, it, vi } from "vitest";
import { arrivalRetryDelayMs, arriveRetryingEndingEpisode, entranceStep, isTerminalArrivalError } from "./entrance";
import type { PublicSpaceArrival } from "./types";

const arrival = (value: Partial<PublicSpaceArrival>): PublicSpaceArrival => value as PublicSpaceArrival;
const apiError = (code: string) => ({ error: { code } });

describe("entranceStep", () => {
  it("tells apart admitted, admitted without access, waiting and declined arrivals", () => {
    const access = { subject: {} } as unknown as NonNullable<PublicSpaceArrival["access"]>;
    expect(entranceStep(arrival({ state: "admitted", access }))).toEqual({ state: "admitted", access });
    expect(entranceStep(arrival({ state: "admitted" }))).toEqual({ state: "admitted_without_access" });
    expect(entranceStep(arrival({ state: "pending", retry_after: 3 }))).toEqual({ state: "pending", retryAfterMs: 3000 });
    expect(entranceStep(arrival({ state: "rejected" }))).toEqual({ state: "declined", reason: "rejected" });
  });
});

describe("arrivalRetryDelayMs", () => {
  it.each([
    [undefined, 1000],
    [-1, 1000],
    [Number.NaN, 1000],
    [0, 250],
    [2, 2000],
    [600, 30000],
  ])("turns retry_after %s into %s ms", (retryAfter, expected) => {
    expect(arrivalRetryDelayMs(retryAfter)).toBe(expected);
  });
});

describe("isTerminalArrivalError", () => {
  it.each([{ status: 404 }, { status: 410 }, apiError("arrival.invalid_handle"), apiError("arrival.unavailable"), apiError("space_public_invite.unavailable")])("treats %j as gone for good", (cause) => {
    expect(isTerminalArrivalError(cause)).toBe(true);
  });

  it.each([{ status: 500 }, apiError("episode.not_active"), new Error("offline"), null])("keeps %j retryable", (cause) => {
    expect(isTerminalArrivalError(cause)).toBe(false);
  });
});

describe("arriveRetryingEndingEpisode", () => {
  it("retries while the old Episode is ending, then returns the new arrival", async () => {
    vi.useFakeTimers();
    try {
      const arrive = vi.fn().mockRejectedValueOnce(apiError("episode.not_active")).mockRejectedValueOnce(apiError("episode.not_active")).mockResolvedValue("arrived");
      const result = arriveRetryingEndingEpisode(arrive);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(result).resolves.toBe("arrived");
      expect(arrive).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails at once on any other error", async () => {
    const arrive = vi.fn().mockRejectedValue(apiError("episode.capacity_exceeded"));
    await expect(arriveRetryingEndingEpisode(arrive)).rejects.toEqual(apiError("episode.capacity_exceeded"));
    expect(arrive).toHaveBeenCalledOnce();
  });
});
