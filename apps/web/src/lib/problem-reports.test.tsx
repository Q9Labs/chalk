/* @vitest-environment jsdom */
/// <reference types="vitest/jsdom" />
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useProblemReports, useReportCredentialExpired } from "./problem-reports";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Probe({ expiresAt }: { readonly expiresAt: number }) {
  return <>{String(useReportCredentialExpired(expiresAt))}</>;
}

it("follows renewed report access after an earlier expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const firstExpiry = Date.now() + 1000;
  await act(async () => root?.render(<Probe expiresAt={firstExpiry} />));
  await act(async () => vi.advanceTimersByTime(1001));
  expect(document.body.textContent).toBe("true");
  await act(async () => root?.render(<Probe expiresAt={Date.now() + 60_000} />));
  expect(document.body.textContent).toBe("false");
});

function AvailabilityProbe({ enabled }: { readonly enabled: boolean }) {
  useProblemReports("https://api.test", "tenant", enabled);
  return null;
}

it("releases the report availability probe while the dialog is closed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const requests: string[] = [];
  const fetchFake: typeof fetch = async (input) => {
    requests.push(String(input));
    return Response.json({ available: true });
  };
  vi.stubGlobal("fetch", fetchFake);
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => root?.render(<AvailabilityProbe enabled={false} />));
  expect(requests).toHaveLength(0);
  await act(async () => root?.render(<AvailabilityProbe enabled={true} />));
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  await act(async () => root?.render(<AvailabilityProbe enabled={false} />));
  window.dispatchEvent(new Event("online"));
  expect(requests).toHaveLength(1);
});
