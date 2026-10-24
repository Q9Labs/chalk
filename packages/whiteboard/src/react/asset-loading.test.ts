// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}

import { expect, it } from "vitest";
import { configureWhiteboardAssets } from "../assets";
import { preloadWhiteboardStylesheet } from "./WhiteboardCanvas";

it("preloads configured local styles while retaining the SDK host default", () => {
  preloadWhiteboardStylesheet();
  const defaultLink = document.querySelector<HTMLLinkElement>("#chalk-excalidraw-styles");
  expect(defaultLink?.href).toBe("https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/index.css");
  defaultLink?.remove();

  configureWhiteboardAssets({ excalidrawCssPath: "/chalk-whiteboard/0.18.1/index.css", mathJaxBasePath: "/chalk-mathjax/4.1.3" });
  expect(window.EXCALIDRAW_ASSET_PATH).toBe(new URL("/chalk-whiteboard/0.18.1/", window.location.href).href);
  preloadWhiteboardStylesheet();
  expect(document.querySelector<HTMLLinkElement>("#chalk-excalidraw-styles")?.getAttribute("href")).toBe("/chalk-whiteboard/0.18.1/index.css");
});

it("resolves relative fonts beside the stylesheet when a host sets a document base", () => {
  document.querySelector("#chalk-excalidraw-styles")?.remove();
  const previousUrl = window.location.href;
  window.history.replaceState(null, "", "/room/board");
  const base = document.createElement("base");
  base.href = "/sdk/";
  document.head.prepend(base);
  try {
    configureWhiteboardAssets({ excalidrawCssPath: "vendor/excalidraw/index.css", mathJaxBasePath: "vendor/mathjax" });
    preloadWhiteboardStylesheet();
    expect(document.baseURI).toBe(`${window.location.origin}/sdk/`);
    expect(window.EXCALIDRAW_ASSET_PATH).toBe(`${window.location.origin}/sdk/vendor/excalidraw/`);
  } finally {
    base.remove();
    document.querySelector("#chalk-excalidraw-styles")?.remove();
    window.history.replaceState(null, "", previousUrl);
  }
});
