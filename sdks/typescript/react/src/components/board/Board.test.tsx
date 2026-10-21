// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient } from "../../test-support/preview-client";
import { Board } from "./Board";
import { SpaceStage } from "../stage/SpaceStage";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import type { ChalkWhiteboardView } from "@q9labsai/chalk-client";

type TestEngine = {
  pan: (x: number, y: number) => void;
  camera: () => { x: number; y: number };
  editText: (editing: boolean, changed?: boolean) => void;
};

const { engineLoaded } = vi.hoisted(() => ({ engineLoaded: vi.fn<(engine: TestEngine) => void>() }));

// The DOM runner cannot render Excalidraw's canvas. Only replace that external
// engine; Board, WhiteboardCanvas and stylesheet ownership run unchanged.
vi.mock("@excalidraw/excalidraw", async () => {
  const { createElement, useEffect, useState } = await import("react");
  type TextElement = { id: string; type: "text"; version: number; isDeleted: boolean };
  type State = { isLoading: boolean; viewBackgroundColor: string; scrollX: number; scrollY: number; zoom: { value: number }; selectedElementIds: object; editingTextElement: { id: string } | null };
  type Change = (elements: readonly TextElement[], state: State, files: object) => void;
  const createEngine = () => {
    let appState: State = { isLoading: false, viewBackgroundColor: "transparent", scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: {}, editingTextElement: null };
    let elements: readonly TextElement[] = [];
    const changes = new Set<Change>();
    const scrolls = new Set<(x: number, y: number, zoom: { value: number }) => void>();
    const notify = () => {
      for (const listener of changes) listener(elements, appState, {});
    };
    const api = {
      getAppState: () => appState,
      getSceneElements: () => elements,
      getSceneElementsIncludingDeleted: () => elements,
      getFiles: () => ({}),
      updateScene: (input: { appState?: Partial<State>; elements?: readonly TextElement[] }) => {
        const before = appState;
        appState = { ...appState, ...input.appState };
        if (input.elements) elements = input.elements;
        if (before.scrollX !== appState.scrollX || before.scrollY !== appState.scrollY || before.zoom.value !== appState.zoom.value) {
          for (const listener of scrolls) listener(appState.scrollX, appState.scrollY, appState.zoom);
        }
        notify();
      },
      setActiveTool: () => undefined,
      scrollToContent: () => undefined,
      onScrollChange: (listener: (x: number, y: number, zoom: { value: number }) => void) => {
        scrolls.add(listener);
        return () => {
          scrolls.delete(listener);
        };
      },
      onPointerDown: () => () => undefined,
      onPointerUp: () => () => undefined,
      onChange: (listener: Change) => {
        changes.add(listener);
        return () => {
          changes.delete(listener);
        };
      },
    };
    const controls: TestEngine = {
      pan: (x, y) => api.updateScene({ appState: { scrollX: x, scrollY: y } }),
      camera: () => ({ x: appState.scrollX, y: appState.scrollY }),
      editText: (editing, changed = false) => {
        if (changed) elements = [{ id: "text", type: "text", version: (elements[0]?.version ?? 0) + 1, isDeleted: false }];
        api.updateScene({ appState: { editingTextElement: editing ? { id: "text" } : null } });
      },
    };
    return { api, controls };
  };
  return {
    getSceneVersion: (elements: readonly TextElement[]) => elements.reduce((sum, element) => sum + element.version, 0),
    CaptureUpdateAction: { NEVER: "NEVER", IMMEDIATELY: "IMMEDIATELY" },
    Excalidraw({ excalidrawAPI, onChange }: { excalidrawAPI: (value: ReturnType<typeof createEngine>["api"]) => void; onChange: Change }) {
      const [engine] = useState(createEngine);
      useEffect(() => {
        excalidrawAPI(engine.api);
        onChange([], engine.api.getAppState(), {});
        engineLoaded(engine.controls);
        return engine.api.onChange(onChange);
      }, [engine, excalidrawAPI, onChange]);
      return createElement("div", { className: "excalidraw" });
    },
  };
});

function createPeer() {
  type Listener = Parameters<NonNullable<WhiteboardViewProps["collab"]>["subscribe"]>[0];
  const listeners = new Set<Listener>();
  const commit = async () => ({ sceneId: "scene", revision: "1" });
  const collab: NonNullable<WhiteboardViewProps["collab"]> = {
    canDraw: true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submitUpdate: commit,
    clear: commit,
    sendCursor: () => undefined,
    requestSnapshot: async () => undefined,
  };
  return {
    board: { collab },
    receive: (participantId: string, view: ChalkWhiteboardView) => {
      for (const listener of listeners) listener({ type: "view", participantId, ...view });
    },
  };
}

function loadedEngines(): readonly TestEngine[] {
  return [...new Set(engineLoaded.mock.calls.map(([engine]) => engine))];
}

async function finishOpening(container: HTMLElement, count = 1) {
  await vi.waitFor(async () => {
    await act(async () => undefined);
    expect(loadedEngines(), `${container.querySelectorAll(".chalk-board").length} boards; ${container.querySelectorAll(".excalidraw").length} canvases; ${container.textContent?.slice(-400)}`).toHaveLength(count);
  });
  const stylesheet = document.getElementById("chalk-excalidraw-styles");
  if (!stylesheet) throw new Error("Board stylesheet was not requested");
  await act(async () => stylesheet.dispatchEvent(new Event("load")));
  expect(container.querySelectorAll('.chalk-board[data-ready="true"]')).toHaveLength(count);
}

it.each([false, true])("mutual followers settle without echoing views, reduced motion %s", async (reduced) => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("prefers-reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  const a = createPeer();
  const b = createPeer();
  const sendA = vi.fn((view: ChalkWhiteboardView) => {
    b.receive("a", view);
    return true;
  });
  const sendB = vi.fn((view: ChalkWhiteboardView) => {
    a.receive("b", view);
    return true;
  });
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const hostA = document.createElement("div");
  const hostB = document.createElement("div");
  container.append(hostA, hostB);
  const rootA = createRoot(hostA);
  const rootB = createRoot(hostB);
  const renderA = (following: boolean) =>
    rootA.render(
      <ChalkProvider client={client}>
        <Board board={a.board} primary visible colorScheme="dark" people={[]} following={following ? "b" : null} onFollow={() => undefined} sendView={sendA} />
      </ChalkProvider>,
    );
  const renderB = (following: boolean) =>
    rootB.render(
      <ChalkProvider client={client}>
        <Board board={b.board} primary visible colorScheme="dark" people={[]} following={following ? "a" : null} onFollow={() => undefined} sendView={sendB} />
      </ChalkProvider>,
    );
  try {
    await act(async () => renderA(false));
    await finishOpening(container);
    await act(async () => renderB(false));
    await finishOpening(container, 2);
    const [engineA, engineB] = loadedEngines();
    if (!engineA || !engineB) throw new Error("Both board engines must be initialized");
    sendA.mockClear();
    sendB.mockClear();
    await act(async () => {
      engineA.pan(-100, -20);
      engineB.pan(-300, -80);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(sendA).toHaveBeenCalled();
    expect(sendB).toHaveBeenCalled();
    await act(async () => {
      renderA(true);
      renderB(true);
    });
    sendA.mockClear();
    sendB.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();
    expect(engineA.camera()).toEqual({ x: -300, y: -80 });
    expect(engineB.camera()).toEqual({ x: -100, y: -20 });
  } finally {
    await act(async () => {
      rootA.unmount();
      rootB.unmount();
    });
    container.remove();
    client.dispose();
  }
});

it("does not resume following when the board closes and reopens", async () => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const tiles = [
    { id: "self", displayName: "Amina", isLocal: true },
    { id: "other", displayName: "Omar" },
  ];
  const render = (isOpen: boolean) =>
    root.render(
      <ChalkProvider client={client}>
        <SpaceStage tiles={tiles} layout="focus" generatedAvatars={false} whiteboard={{ isOpen, props: {}, sendView: () => true }} />
      </ChalkProvider>,
    );
  try {
    await act(async () => render(true));
    const follow = container.querySelector('[aria-label="Video tile for Omar"]');
    if (!(follow instanceof HTMLElement)) throw new Error("Omar's tile is missing");
    await act(async () => follow.click());
    expect(container.querySelector('[data-stage-item="other"]')?.textContent).toContain("following");
    await act(async () => render(false));
    await act(async () => render(true));
    expect(container.querySelector('[data-stage-item="other"]')?.textContent).not.toContain("following");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("preserves redo and disabled Undo when text editing makes no scene change", async () => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const found = container.querySelector(`button[aria-label="${label}"]`);
    if (!(found instanceof HTMLButtonElement)) throw new Error(`${label} control is missing`);
    return found;
  };
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Board board={{}} primary visible colorScheme="dark" people={[]} following={null} onFollow={() => undefined} />
        </ChalkProvider>,
      ),
    );
    await finishOpening(container);
    const engine = loadedEngines()[0];
    if (!engine) throw new Error("Board engine must be initialized");
    await act(async () => engine.editText(true));
    await act(async () => engine.editText(false, true));
    expect(button("Undo").disabled).toBe(false);
    await act(async () => button("Undo").click());
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(false);
    await act(async () => engine.editText(true));
    await act(async () => engine.editText(false));
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(false);
    await act(async () => engine.editText(true));
    await act(async () => engine.editText(false, true));
    expect(button("Undo").disabled).toBe(false);
    expect(button("Redo").disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

beforeEach(async () => {
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
});

afterEach(() => {
  document.getElementById("chalk-excalidraw-styles")?.remove();
  engineLoaded.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "fonts");
});

it.each(["load", "error"])("keeps Opening board while the engine is initialized but its stylesheet awaits %s", async (outcome) => {
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
