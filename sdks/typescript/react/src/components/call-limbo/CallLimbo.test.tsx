// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CallLimbo } from "./CallLimbo";

afterEach(() => document.body.replaceChildren());

it.each(["declined", "expired"] as const)("draws the %s glyph in the call's 1.75 outline family", (glyph) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<CallLimbo message="The host didn’t let you in" glyph={glyph} />));
  const icon = document.querySelector("[data-part=limbo-message] svg");
  expect(icon?.getAttribute("stroke-width")).toBe("1.75");
  expect(icon?.getAttribute("viewBox")).toBe("0 0 24 24");
  act(() => root.unmount());
});
