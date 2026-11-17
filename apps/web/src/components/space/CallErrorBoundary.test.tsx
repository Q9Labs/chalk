// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CallErrorBoundary } from "./CallErrorBoundary";

function Crash(): never {
  throw new Error("render failed");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reports a render crash once and shows a way to reload", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let crashes = 0;
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <CallErrorBoundary onCrash={() => (crashes += 1)}>
        <Crash />
      </CallErrorBoundary>,
    );
  });
  expect(crashes).toBe(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Reload to rejoin");
  await act(async () => root.unmount());
});
