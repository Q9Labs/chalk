// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { durations } from "../theme/tokens";
import { useLandscapeChrome } from "./use-landscape-chrome";

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.useRealTimers();
  document.body.replaceChildren();
});

it("keeps landscape board touches available across the idle deadline and removes an already hidden overlay", async () => {
  vi.useFakeTimers();
  function Frame({ boardVisible }: { readonly boardVisible: boolean }) {
    const chrome = useLandscapeChrome({ fades: true, boardVisible });
    return chrome.hidden ? <button onClick={chrome.show}>Show call controls</button> : <span>Call controls visible</span>;
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Frame boardVisible={true} />));
  await act(async () => vi.advanceTimersByTime(durations.landscapeHide * 3));
  expect(container.querySelector("button")).toBeNull();
  await act(async () => root.render(<Frame boardVisible={false} />));
  await act(async () => vi.advanceTimersByTime(durations.landscapeHide));
  expect(container.querySelector("button")?.textContent).toBe("Show call controls");
  await act(async () => root.render(<Frame boardVisible={true} />));
  expect(container.querySelector("button")).toBeNull();
  await act(async () => vi.advanceTimersByTime(durations.landscapeHide * 3));
  expect(container.querySelector("button")).toBeNull();
});
