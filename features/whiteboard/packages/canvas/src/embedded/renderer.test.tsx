// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { encodeEmbeddedWhiteboardMessage } from "./protocol";

vi.mock("@excalidraw/excalidraw", () => ({ exportToBlob: vi.fn(), exportToSvg: vi.fn() }));
vi.mock("@q9labsai/facehash/react", () => ({ Facehash: () => null }));
vi.mock("../react/board/Board", () => ({ Board: () => createElement("div", { "data-board": "true" }, "Chalk board") }));
vi.mock("../react/WhiteboardCanvas", () => ({ WhiteboardCanvas: () => createElement("div", { "data-canvas": "true" }, "Drawing canvas") }));

it("opens a drawing canvas for bridge-v1 hosts that omit the optional board context", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState({}, "", "/?journeyId=legacy-host&rendererGeneration=legacy-renderer");
  window.ReactNativeWebView = { postMessage: vi.fn() };
  await import("./renderer");
  await expect.poll(() => vi.mocked(window.ReactNativeWebView!.postMessage).mock.calls.length).toBeGreaterThan(0);
  window.dispatchEvent(new MessageEvent("message", { data: encodeEmbeddedWhiteboardMessage({ type: "initialize", payload: { canDraw: true, canClear: false, theme: "light" } }, { journeyId: "legacy-host", rendererGeneration: "legacy-renderer", nextMessageId: () => "initialize-legacy" }) }));
  await expect.poll(() => document.querySelector("[data-canvas]")?.textContent).toBe("Drawing canvas");
  expect(document.body.textContent).not.toContain("Opening board");
});
