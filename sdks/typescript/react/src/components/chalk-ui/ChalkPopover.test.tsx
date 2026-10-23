// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChalkPopover } from "./ChalkPopover";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("fits the window when no call holds it", async () => {
  // happy-dom does no layout, so give the window a size. Everything else stays 0 by 0.
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ChalkPopover open trigger={<button type="button">Notices</button>} label="Notices">
        Nora joined
      </ChalkPopover>,
    ),
  );
  const room = await vi.waitFor(() => {
    const height = document.querySelector<HTMLElement>(".chalk-popover-positioner")?.style.getPropertyValue("--available-height");
    if (!height) throw new Error("The popover isn't placed yet");
    return Number.parseFloat(height);
  });
  expect(room).toBeGreaterThan(0);
  await act(async () => root.unmount());
});
