// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient } from "../../test-support/preview-client";
import { Board } from "./Board";

const gate = vi.hoisted(() => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
});
vi.mock("../../../../../../packages/whiteboard/src/collab/engine", async (original) => {
  await gate.pending;
  return original();
});
vi.mock("@excalidraw/excalidraw", async () => {
  const { createElement, useEffect } = await import("react");
  const state = { isLoading: false, viewBackgroundColor: "transparent", selectedElementIds: {}, scrollX: 0, scrollY: 0, zoom: { value: 1 } };
  const api = {
    getAppState: () => state,
    getSceneElements: () => [],
    getSceneElementsIncludingDeleted: () => [],
    getFiles: () => ({}),
    updateScene: () => {},
    setActiveTool: () => {},
    registerAction: () => {},
    onScrollChange: () => () => {},
    onPointerDown: () => () => {},
    onPointerUp: () => () => {},
    onChange: () => () => {},
  };
  return {
    CaptureUpdateAction: { NEVER: "NEVER" },
    getSceneVersion: () => 0,
    Excalidraw({ excalidrawAPI, onChange }: { excalidrawAPI: (api: object) => void; onChange: (elements: readonly object[], state: object, files: object) => void }) {
      // nosemgrep: chalk.forbid-sdk-use-effect -- Exercise the mounted collaboration API in the existing integration fixture.
      useEffect(() => {
        excalidrawAPI(api);
        onChange([], state, {});
      }, [excalidrawAPI, onChange]);
      return createElement("div", { className: "excalidraw" });
    },
  };
});

it("keeps Opening board until the shared collaboration engine exists", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: async () => [] } });
  const client = createPreviewClient();
  const rootElement = document.createElement("div");
  document.body.append(rootElement);
  const root = createRoot(rootElement);
  const commit = async () => ({ sceneId: "scene", revision: "1" });
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Board primary visible board={{ collab: { canDraw: true, subscribe: () => () => {}, submitUpdate: commit, clear: commit, sendCursor: () => {}, requestSnapshot: async () => {} } }} colorScheme="dark" people={[]} following={null} onFollow={() => {}} />
        </ChalkProvider>,
      ),
    );
    await vi.waitFor(() => expect(rootElement.querySelector(".excalidraw")).not.toBeNull());
    await act(async () => document.getElementById("chalk-excalidraw-styles")?.dispatchEvent(new Event("load")));
    expect(rootElement.textContent).toContain("Opening board");
    expect(rootElement.querySelector('button[aria-label="Board menu"]')).toBeNull();
    await act(async () => gate.release());
    await vi.waitFor(() => expect(rootElement.querySelector('.chalk-board[data-ready="true"]')).not.toBeNull());
  } finally {
    gate.release();
    await act(async () => root.unmount());
    rootElement.remove();
    client.dispose();
    document.getElementById("chalk-excalidraw-styles")?.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "fonts");
  }
});
