// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ReactionTray } from "./ReactionTray";

afterEach(() => document.body.replaceChildren());

it("closes when another control is clicked, but only once the click lands, so the control still gets it", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const events: string[] = [];
  const other = document.body.appendChild(document.createElement("button"));
  other.addEventListener("click", () => events.push("control"));
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<ReactionTray reactions={["👍"]} onSelect={() => events.push("react")} onClose={() => events.push("close")} />));

  act(() => void other.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(events).toEqual([]);
  act(() => other.click());
  expect(events).toEqual(["close", "control"]);

  const thumbs = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "React with 👍");
  act(() => thumbs?.click());
  expect(events).toEqual(["close", "control", "react"]);
  act(() => root.unmount());
});
