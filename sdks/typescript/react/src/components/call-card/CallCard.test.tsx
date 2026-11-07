// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { NarrowCallProvider } from "../../internal/call-width";
import { CallCard } from "./CallCard";

it.each([
  { call: "narrow", narrow: true, drawer: false },
  { call: "wide", narrow: false, drawer: true },
])("opens panels as a sheet only in a narrow call in a wide window: $call call", async ({ narrow, drawer }) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true }));
  const container = document.createElement("div");
  container.dataset.chalk = "";
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <NarrowCallProvider value={narrow}>
          <CallCard state="open">People</CallCard>
        </NarrowCallProvider>,
      ),
    );
    expect(container.querySelector("[data-chalk-drawer]") !== null).toBe(drawer);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
