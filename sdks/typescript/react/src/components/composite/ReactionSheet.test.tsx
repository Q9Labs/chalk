// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ReactionSheet from "./ReactionSheet";

afterEach(() => document.body.replaceChildren());

it("hides the dock while the phone sheet is open and restores it when closed", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const frame = document.body.appendChild(document.createElement("div"));
  frame.dataset.part = "call-frame";
  frame.innerHTML = `<div data-chalk><div data-part="dock"><button type="button">Present</button></div><div data-part="root"></div></div>`;
  const dock = frame.querySelector<HTMLElement>("[data-part='dock']");
  const mount = frame.querySelector<HTMLElement>("[data-part='root']");
  if (!dock || !mount) throw new Error("fixture missing");
  const root = createRoot(mount);
  const props = {
    isHandRaised: false,
    reactions: ["👍"],
    onSelect: () => {},
    onClose: () => {},
  };

  act(() => root.render(<ReactionSheet {...props} open />));
  expect(dock.style.visibility).toBe("hidden");

  act(() => root.render(<ReactionSheet {...props} open={false} />));
  expect(dock.style.visibility).toBe("");
  act(() => root.unmount());
});
