// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}

import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WhiteboardCanvas, preloadWhiteboardStylesheet } from "./WhiteboardCanvas";

vi.mock("@excalidraw/excalidraw", () => ({ Excalidraw: () => createElement("canvas", { "data-engine": "true" }) }));

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

it.each(["static", "dynamic"])("opens when the %s stylesheet loaded before the canvas mounted", async (path) => {
  if (path === "static") document.head.innerHTML = '<link id="chalk-excalidraw-styles" rel="stylesheet" href="./index.css">';
  else preloadWhiteboardStylesheet("./index.css");

  const link = document.querySelector("link");
  if (!link) throw new Error("Missing board stylesheet");
  // The DOM emulator does not fetch stylesheets; expose the browser's completed sheet state.
  vi.spyOn(link, "sheet", "get").mockReturnValue(new CSSStyleSheet());
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(WhiteboardCanvas, { excalidrawCssPath: "./index.css", isVisible: true }));

  await expect.poll(() => container.querySelector("[data-engine]")).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await expect.poll(() => container.textContent).not.toContain("Loading whiteboard");
  expect(document.querySelectorAll("link")).toHaveLength(1);
});
