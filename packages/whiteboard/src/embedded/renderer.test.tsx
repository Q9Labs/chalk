// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChalkEmbeddedWhiteboardRendererBridge } from "./renderer-bridge";
import { decodeEmbeddedWhiteboardRendererMessage } from "./protocol";

const rendererTestState = vi.hoisted(() => ({
  createRoot: vi.fn(),
  render: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  createRoot: rendererTestState.createRoot,
}));
vi.mock("@excalidraw/excalidraw", () => ({
  exportToBlob: vi.fn(),
  exportToSvg: vi.fn(),
}));
vi.mock("../react/WhiteboardCanvas.js", () => ({
  WhiteboardCanvas: vi.fn(),
}));

describe("embedded whiteboard renderer entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState({}, "", "/?journeyId=journey-test&rendererGeneration=renderer-generation-test");
    document.body.innerHTML = '<div id="root"></div>';
    rendererTestState.render.mockReset();
    rendererTestState.createRoot.mockReset();
    rendererTestState.createRoot.mockReturnValue({ render: rendererTestState.render });
  });

  it("boots only into the local root and configures local Excalidraw assets", async () => {
    await import("./renderer");

    expect(window.EXCALIDRAW_ASSET_PATH).toBe("./");
    expect(rendererTestState.createRoot).toHaveBeenCalledWith(document.getElementById("root"));
    expect(rendererTestState.render).toHaveBeenCalledOnce();
  });

  it("fails closed when the package root is absent", async () => {
    document.body.innerHTML = "";

    await expect(import("./renderer")).rejects.toThrow("embedded whiteboard root is missing");
  });

  it("strips runtime-only Excalidraw fields from cursor messages", async () => {
    window.ReactNativeWebView = { postMessage: vi.fn() };
    const { createCollaborationBridge } = await import("./renderer");
    const bridge = new ChalkEmbeddedWhiteboardRendererBridge();
    const collaboration = createCollaborationBridge(bridge);
    const pointer = { x: 12, y: 34, tool: "pointer" };

    collaboration.sendCursor(pointer);

    const raw = vi.mocked(window.ReactNativeWebView.postMessage).mock.calls[0]?.[0];
    expect(decodeEmbeddedWhiteboardRendererMessage(String(raw), "renderer-generation-test")).toMatchObject({
      type: "cursor",
      payload: { x: 12, y: 34 },
    });
    expect(JSON.parse(String(raw)).payload).not.toHaveProperty("tool");
  });
});
