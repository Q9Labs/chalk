// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient } from "../../test-support/preview-client";
import { Board } from "./Board";

const { engineLoaded } = vi.hoisted(() => ({ engineLoaded: vi.fn() }));

// The DOM runner cannot render Excalidraw's canvas. Only replace that external
// engine; Board, WhiteboardCanvas and stylesheet ownership run unchanged.
vi.mock("@excalidraw/excalidraw", async () => {
  const { useEffect } = await import("react");
  const appState = { isLoading: false, viewBackgroundColor: "transparent", scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {} };
  const unsubscribe = () => () => undefined;
  const api = {
    getAppState: () => appState,
    getSceneElements: () => [],
    getSceneElementsIncludingDeleted: () => [],
    updateScene: vi.fn(),
    onScrollChange: unsubscribe,
    onPointerDown: unsubscribe,
    onPointerUp: unsubscribe,
    onChange: unsubscribe,
  };
  return {
    getSceneVersion: () => 0,
    Excalidraw({ excalidrawAPI, onChange }: { excalidrawAPI: (value: typeof api) => void; onChange: (elements: readonly never[], state: typeof appState, files: object) => void }) {
      useEffect(() => {
        excalidrawAPI(api);
        onChange([], appState, {});
        engineLoaded();
      }, [excalidrawAPI, onChange]);
      return null;
    },
  };
});

afterEach(() => {
  document.getElementById("chalk-excalidraw-styles")?.remove();
  engineLoaded.mockClear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fonts");
});

it.each(["load", "error"])("keeps Opening board while the engine is initialized but its stylesheet awaits %s", async (outcome) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: async () => [] } });
  await import("@excalidraw/excalidraw");
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ChalkProvider client={client}>
          <Board board={{}} primary={false} visible colorScheme="dark" people={[]} following={null} onFollow={() => undefined} />
        </ChalkProvider>,
      );
    });
    await vi.waitFor(async () => {
      await act(async () => undefined);
      expect(engineLoaded, container.textContent ?? "").toHaveBeenCalled();
    });
    const stylesheet = document.getElementById("chalk-excalidraw-styles");
    if (!(stylesheet instanceof HTMLLinkElement)) throw new Error("Board stylesheet was not requested");
    expect(container.querySelector(".chalk-board-loading")?.textContent).toContain("Opening board");
    expect(container.querySelector(".chalk-board")?.hasAttribute("data-ready")).toBe(false);

    await act(async () => stylesheet.dispatchEvent(new Event(outcome)));
    if (outcome === "load") {
      expect(container.querySelector(".chalk-board-loading")).toBeNull();
      expect(container.querySelector(".chalk-board")?.getAttribute("data-ready")).toBe("true");
    } else {
      expect(container.querySelector(".chalk-board-loading")?.textContent).toContain("Opening board");
      expect(container.querySelector(".chalk-board")?.hasAttribute("data-ready")).toBe(false);
      expect(container.textContent).toContain("Failed to load");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});
