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

function participantClient(participantId: string) {
  const client = createPreviewClient();
  client.updateSnapshot((snapshot) => ({ ...snapshot, self: { ...snapshot.self, participantId } }));
  return client;
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

it.each([
  [2, false, false],
  [2, true, false],
  [2, false, true],
  [2, true, true],
  [3, false, false],
  [3, true, false],
] as const)("%s cyclic followers settle after crossed 50 ms updates: reduced %s, different shapes %s", async (count, reduced, differentShapes) => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("prefers-reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  if (differentShapes) {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return Number(this.closest<HTMLElement>("[data-width]")?.dataset.width) || 1;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return Number(this.closest<HTMLElement>("[data-height]")?.dataset.height) || 1;
    });
  }
  const peers = Array.from({ length: count }, () => createPeer());
  const sequences = peers.map(() => 0);
  const sends = peers.map((_, index) =>
    vi.fn((view: ChalkWhiteboardView) => {
      const frame = view.originParticipantId ? view : { ...view, originParticipantId: String(index), originSequence: (sequences[index] = (sequences[index] ?? 0) + 1) };
      for (const [other, peer] of peers.entries()) if (other !== index) setTimeout(() => peer.receive(String(index), frame), 50);
      return true;
    }),
  );
  const clients = peers.map((_, index) => participantClient(String(index)));
  const container = document.createElement("div");
  document.body.append(container);
  const roots = peers.map((_, index) => {
    const host = document.createElement("div");
    if (differentShapes) {
      host.dataset.width = index ? "600" : "1200";
      host.dataset.height = index ? "1200" : "600";
    }
    container.append(host);
    return createRoot(host);
  });
  const render = (index: number, follows: boolean) => {
    const client = clients[index];
    if (!client) throw new Error("Participant client is missing");
    roots[index]?.render(
      <ChalkProvider client={client}>
        <Board board={peers[index]?.board ?? {}} primary visible colorScheme="dark" people={[]} following={follows ? String((index + count - 1) % count) : null} onFollow={() => undefined} sendView={sends[index]} />
      </ChalkProvider>,
    );
  };
  try {
    for (const index of peers.keys()) {
      await act(async () => render(index, false));
      await finishOpening(container, index + 1);
    }
    const engines = loadedEngines();
    await act(async () => {
      engines.forEach((engine, index) => engine.pan(-100 * (index + 1), -20 * (index + 1)));
      await vi.advanceTimersByTimeAsync(200);
    });
    await act(async () => peers.forEach((_, index) => render(index, true)));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    const settled = engines.map((engine) => engine.camera());
    sends.forEach((send) => send.mockClear());
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    sends.forEach((send) => expect(send).not.toHaveBeenCalled());
    expect(engines.map((engine) => engine.camera())).toEqual(settled);
  } finally {
    await act(async () => roots.forEach((root) => root.unmount()));
    container.remove();
    clients.forEach((client) => client.dispose());
  }
});

it.each([false, true])("relays a leader through C → B → A, reduced motion %s", async (reduced) => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("prefers-reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  const peers = [createPeer(), createPeer(), createPeer()];
  const sequences = [0, 0, 0];
  const sends = peers.map((_, index) =>
    vi.fn((view: ChalkWhiteboardView) => {
      const frame = view.originParticipantId ? view : { ...view, originParticipantId: String(index), originSequence: (sequences[index] = (sequences[index] ?? 0) + 1) };
      for (const [other, peer] of peers.entries()) if (other !== index) setTimeout(() => peer.receive(String(index), frame), 50);
      return true;
    }),
  );
  const clients = peers.map((_, index) => participantClient(String(index)));
  const container = document.createElement("div");
  document.body.append(container);
  const roots = peers.map(() => {
    const host = document.createElement("div");
    container.append(host);
    return createRoot(host);
  });
  try {
    for (const [index, root] of roots.entries()) {
      const peer = peers[index];
      const client = clients[index];
      if (!peer || !client) throw new Error("Peer is missing");
      await act(async () =>
        root.render(
          <ChalkProvider client={client}>
            <Board board={peer.board} primary visible colorScheme="dark" people={[]} following={index === 0 ? null : String(index - 1)} onFollow={() => undefined} sendView={sends[index]} />
          </ChalkProvider>,
        ),
      );
      await finishOpening(container, index + 1);
      if (index === 0) {
        const leader = loadedEngines()[0];
        if (!leader) throw new Error("Leader must be initialized");
        await act(async () => {
          leader.pan(-100, -200);
          await vi.advanceTimersByTimeAsync(200);
        });
      }
    }
    const [leader, middle, follower] = loadedEngines();
    if (!leader || !middle || !follower) throw new Error("Three board engines must be initialized");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(follower.camera().x).toBeCloseTo(-100, 2);
    expect(follower.camera().y).toBeCloseTo(-200, 2);
    await act(async () => {
      leader.pan(-345.6789, -123.4567);
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(middle.camera().x).toBeCloseTo(leader.camera().x, 2);
    expect(follower.camera().x).toBeCloseTo(leader.camera().x, 2);
    expect(follower.camera().y).toBeCloseTo(leader.camera().y, 2);
    const latest = sends[1]?.mock.calls.at(-1)?.[0];
    if (!latest?.originParticipantId || latest.originSequence === undefined) throw new Error("The relay must preserve its origin version");
    const settled = follower.camera();
    sends[2]?.mockClear();
    await act(async () => {
      peers[2]?.receive("1", { ...latest, x: 999, originSequence: latest.originSequence - 1 });
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(follower.camera()).toEqual(settled);
    expect(sends[2]).not.toHaveBeenCalledWith(expect.objectContaining({ x: 999 }));
  } finally {
    await act(async () => roots.forEach((root) => root.unmount()));
    container.remove();
    clients.forEach((client) => client.dispose());
  }
});

it("sends a follower's own manual move, including subpixel movement", async () => {
  vi.useFakeTimers();
  const peer = createPeer();
  const sendView = vi.fn(() => true);
  const onFollow = vi.fn();
  const client = participantClient("follower");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Board board={peer.board} primary visible colorScheme="dark" people={[]} following="leader" onFollow={onFollow} sendView={sendView} />
        </ChalkProvider>,
      ),
    );
    await finishOpening(container);
    const [engine] = loadedEngines();
    if (!engine) throw new Error("Board engine must be initialized");
    await act(async () => {
      peer.receive("leader", { x: 999, y: 999, width: 1, height: 1, bring: false, originParticipantId: "follower", originSequence: 1 });
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(engine.camera()).toEqual({ x: 0, y: 0 });
    sendView.mockClear();
    await act(async () => {
      engine.pan(-123, -456);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onFollow).toHaveBeenCalledWith(null);
    expect(sendView).toHaveBeenCalledWith(expect.objectContaining({ x: 123, y: 456, bring: false }));
    sendView.mockClear();
    await act(async () => {
      engine.pan(-123.001, -456.001);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(sendView).toHaveBeenCalledWith(expect.objectContaining({ x: 123.001, y: 456.001 }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("lets the island handle Home, End and Alt+Arrow through the board key guard", async () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Board board={{}} primary visible colorScheme="dark" people={[]} following={null} onFollow={() => undefined} />
        </ChalkProvider>,
      ),
    );
    await finishOpening(container);
    const island = container.querySelector<HTMLElement>(".chalk-board-island");
    const grip = island?.querySelector<HTMLButtonElement>(".chalk-board-grip");
    if (!island || !grip) throw new Error("Drawing island must be ready");
    grip.focus();
    await act(async () => grip.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/^Colour:/);
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(grip);
    await act(async () => grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true })));
    expect(island.dataset.place).toBe("left");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("does not permanently hide Follow after one rejected view send", async () => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const sendView = vi.fn(() => false);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceStage
            tiles={[
              { id: "self", displayName: "Amina", isLocal: true },
              { id: "other", displayName: "Omar" },
            ]}
            layout="focus"
            generatedAvatars={false}
            whiteboard={{ isOpen: true, props: {}, sendView }}
          />
        </ChalkProvider>,
      ),
    );
    await finishOpening(container);
    expect(sendView).toHaveBeenCalled();
    const follow = container.querySelector('[aria-label="Video tile for Omar"]');
    if (!(follow instanceof HTMLElement)) throw new Error("Omar's tile is missing");
    await act(async () => follow.click());
    expect(container.querySelector('[data-stage-item="other"]')?.textContent).toContain("following");
  } finally {
    await act(async () => root.unmount());
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
  vi.restoreAllMocks();
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
