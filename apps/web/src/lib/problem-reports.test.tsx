import { useProblemReports } from "./problem-reports";
// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["network", "status", "json"])("recovers report availability after a transient %s failure", async (failure) => {
  vi.useFakeTimers();
  const fetch = vi.fn();
  if (failure === "network") fetch.mockRejectedValueOnce(new TypeError("offline"));
  else fetch.mockResolvedValueOnce(new Response(failure === "json" ? "{" : "unavailable", { status: failure === "status" ? 503 : 200 }));
  fetch.mockResolvedValue(new Response(JSON.stringify({ available: true })));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useProblemReports("https://api.chalk.test", "tenant-1"));
  await act(async () => {});
  expect(result.current).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(result.current).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not poll a successful disabled response", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(Response.json({ available: false }));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useProblemReports("https://api.chalk.test", "tenant-1"));
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(result.current).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("recovers the report control after an outage lasting ten minutes", async () => {
  vi.useFakeTimers();
  let online = false;
  const fetch = vi.fn(async () => {
    if (!online) throw new TypeError("offline");
    return Response.json({ available: true });
  });
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useProblemReports("https://api.chalk.test", "tenant-1"));
  await act(async () => vi.advanceTimersByTimeAsync(600_000));
  expect(result.current).toBe(false);
  expect(fetch.mock.calls.length).toBeGreaterThan(4);
  expect(fetch.mock.calls.length).toBeLessThan(20);
  online = true;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(result.current).toBe(true);
});

it("probes immediately on browser online, without waiting for the backoff", async () => {
  vi.useFakeTimers();
  let online = false;
  const fetch = vi.fn(async () => {
    if (!online) throw new TypeError("offline");
    return Response.json({ available: true });
  });
  vi.stubGlobal("fetch", fetch);
  const { result, unmount } = renderHook(() => useProblemReports("https://api.chalk.test", "tenant-1"));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  online = true;
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(result.current).toBe(true);
  unmount();
  const calls = fetch.mock.calls.length;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fetch).toHaveBeenCalledTimes(calls);
});

it("cancels pending availability retries on unmount", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch);
  const { unmount } = renderHook(() => useProblemReports("https://api.chalk.test", "tenant-1"));
  await act(async () => {});
  unmount();
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("waits for a tenant scope before probing its report availability", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ available: true })));
  vi.stubGlobal("fetch", fetch);
  const initialProps: { tenantId: string | undefined } = { tenantId: undefined };
  const { result, rerender } = renderHook(({ tenantId }: { tenantId: string | undefined }) => useProblemReports("https://api.chalk.test", tenantId), { initialProps });
  expect(fetch).not.toHaveBeenCalled();
  rerender({ tenantId: "tenant-1" });
  await act(async () => {});
  expect(fetch).toHaveBeenCalledWith("https://api.chalk.test/v1/tenants/tenant-1/problem-reports/availability", expect.anything());
  expect(result.current).toBe(true);
});
