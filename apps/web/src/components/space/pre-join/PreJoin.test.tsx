// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { PreJoin } from "./PreJoin";

// The SDK entry pulls in the whiteboard, which probes a canvas at import time.
const restoreCanvas = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  if (!descriptor) throw new Error("Missing canvas browser boundary");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({ filter: "none" }) });
  return () => Object.defineProperty(HTMLCanvasElement.prototype, "getContext", descriptor);
});
afterAll(restoreCanvas);
afterEach(() => document.body.replaceChildren());

it("draws every lobby icon in the call's family: 1.75 outline glyphs, none from the older icon set", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<PreJoin spaceName="Q9 team" displayName="Hasan" onDisplayNameChange={() => undefined} joining={false} onJoin={() => undefined} />));
  const icons = [...document.querySelectorAll("svg")];
  expect(icons.length).toBeGreaterThan(3);
  expect(icons.map((icon) => icon.getAttribute("stroke-width"))).toEqual(icons.map(() => "1.75"));
  await act(async () => root.unmount());
});

it("shows the joining spinner as the call's ring, not an icon", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<PreJoin displayName="Hasan" onDisplayNameChange={() => undefined} joining onJoin={() => undefined} />));
  const join = document.querySelector("button[aria-busy=true]");
  expect(join?.textContent).toBe("Joining…");
  expect(join?.querySelector(".animate-spin")).not.toBeNull();
  expect(join?.querySelector("svg")).toBeNull();
  await act(async () => root.unmount());
});
