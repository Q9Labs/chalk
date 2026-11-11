// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useProblemReports } from "./problem-reports";

function Probe({ onResult }: { readonly onResult: (offered: boolean) => void }) {
  onResult(useProblemReports("https://api.example.test", "tenant-1"));
  return null;
}

async function offeredAfter(answer: () => Promise<Response>): Promise<boolean[]> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(answer));
  const results: boolean[] = [];
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(<Probe onResult={(offered) => results.push(offered)} />);
  });
  await act(async () => {});
  await act(async () => root.unmount());
  return results;
}

afterEach(() => vi.unstubAllGlobals());

it("offers reports while the probe is pending and after the server says they are available", async () => {
  expect(await offeredAfter(() => Promise.resolve(Response.json({ available: true })))).toEqual([true]);
});

it("keeps offering reports when the probe fails, so a flaky network never hides the menu item", async () => {
  vi.useFakeTimers();
  try {
    expect(await offeredAfter(() => Promise.reject(new Error("offline")))).toEqual([true]);
  } finally {
    vi.useRealTimers();
  }
});

it("stops offering reports only when the server says they are off", async () => {
  const results = await offeredAfter(() => Promise.resolve(Response.json({ available: false })));
  expect(results[0]).toBe(true);
  expect(results.at(-1)).toBe(false);
});
