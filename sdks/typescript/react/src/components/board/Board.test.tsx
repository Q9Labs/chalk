// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { Board } from "./Board";
import { SpaceStage } from "../stage/SpaceStage";
import * as BoardMenuModule from "./BoardMenu";
import { BoardToastContext } from "./board-toasts";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import type { ChalkWhiteboardView } from "@q9labsai/chalk-client";

type TestEngine = {
  pan: (x: number, y: number) => void;
  camera: () => { x: number; y: number };
  editText: (editing: boolean, changed?: boolean) => void;
  select: (kind: "note" | "highlighter") => void;
  elements: () => readonly { strokeColor?: string; strokeWidth?: number; backgroundColor?: string; opacity?: number; isDeleted: boolean }[];
  deleteSelection: () => void;
};

const { engineLoaded } = vi.hoisted(() => ({ engineLoaded: vi.fn<(engine: TestEngine) => void>() }));

// The DOM runner cannot render Excalidraw's canvas. Only replace that external
// engine; Board, WhiteboardCanvas and stylesheet ownership run unchanged.
vi.mock("@excalidraw/excalidraw", async () => {
  const { createElement, useEffect, useState } = await import("react");
  type TextElement = { id: string; type: string; version: number; isDeleted: boolean; strokeColor?: string; strokeWidth?: number; backgroundColor?: string; opacity?: number; customData?: object };
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
      elements: () => elements,
      select: (kind) => {
        elements = [
          { id: "selected", type: kind === "note" ? "rectangle" : "freedraw", version: 1, isDeleted: false, strokeColor: "#ff9b3d", backgroundColor: "#ff9b3d", strokeWidth: (4.5 * 4) / 4.25, opacity: kind === "highlighter" ? 40 : 100, customData: kind === "note" ? { chalkNote: true } : {} },
        ];
        api.updateScene({ appState: { selectedElementIds: { selected: true } } });
      },
      deleteSelection: () => {
        elements = elements.map((element) => ({ ...element, isDeleted: true, version: element.version + 1 }));
        notify();
      },
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
    newElementWith: (element: TextElement, update: Partial<TextElement>) => ({ ...element, ...update, version: element.version + 1 }),
    convertToExcalidrawElements: (elements: readonly object[]) => elements.map((element, index) => ({ ...element, id: `note-${index}`, version: 1, isDeleted: false })),
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
  const clear = vi.fn(commit);
  const collab: NonNullable<WhiteboardViewProps["collab"]> = {
    canDraw: true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submitUpdate: commit,
    clear,
    sendCursor: () => undefined,
    requestSnapshot: async () => undefined,
  };
  return {
    board: { collab },
    clear,
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
  await vi.waitFor(() => expect(container.querySelectorAll('.chalk-board[data-ready="true"]')).toHaveLength(count));
}

it.each([
  [2, false, false, false],
  [2, true, false, false],
  [2, false, true, false],
  [2, true, true, false],
  [3, false, false, false],
  [3, true, false, false],
  [2, false, false, true],
] as const)("%s cyclic followers settle after crossed 50 ms updates: reduced %s, different shapes %s, legacy %s", async (count, reduced, differentShapes, legacy) => {
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
      const frame = legacy ? { x: view.x, y: view.y, width: view.width, height: view.height, bring: view.bring } : view.originParticipantId ? view : { ...view, originParticipantId: String(index), originSequence: (sequences[index] = (sequences[index] ?? 0) + 1) };
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
    await act(async () => {
      peers[2]?.receive("1", { ...latest, x: 432, originSequence: 1, originEpoch: "reconnected" });
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(follower.camera().x).toBeCloseTo(-432, 2);
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
    const follow = container.querySelector('[aria-label="Follow Omar"]');
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
    const follow = container.querySelector('[aria-label="Follow Omar"]');
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

async function withOpenBoard(check: (container: HTMLElement, engine: TestEngine, peer: ReturnType<typeof createPeer>, toast: ReturnType<typeof vi.fn>) => Promise<void>, primary = true) {
  const client = createPreviewClient(createSnapshot(["drawWhiteboard", "manageWhiteboard"]));
  const peer = createPeer();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const toast = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <BoardToastContext value={toast}>
            <Board board={peer.board} primary={primary} visible colorScheme="dark" people={[]} following="remote" onFollow={() => undefined} sendView={() => true} />
          </BoardToastContext>
        </ChalkProvider>,
      ),
    );
    await finishOpening(container);
    const engine = loadedEngines()[0];
    if (!engine) throw new Error("Missing board engine");
    await check(container, engine, peer, toast);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
}

async function clickControl(container: ParentNode, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}

it("receives followed views while the active board is a grid tile", async () => {
  vi.useFakeTimers();
  await withOpenBoard(async (_container, engine, peer) => {
    await act(async () => {
      peer.receive("remote", { x: 75, y: 25, width: 1, height: 1, bring: false });
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(engine.camera().x).toBeCloseTo(-75, 2);
  }, false);
});

it("keeps redo when colour changes without a selected scene element", async () => {
  await withOpenBoard(async (container, engine) => {
    await act(async () => {
      engine.editText(true);
      engine.editText(false, true);
    });
    await clickControl(container, "Undo");
    await clickControl(container, "Colour: Ink");
    await clickControl(document, "Red");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(true);
  });
});

it("counts an actual keyboard deletion of existing scene content", async () => {
  vi.useFakeTimers();
  await withOpenBoard(async (container, engine) => {
    await act(async () => engine.select("note"));
    const canvas = container.querySelector(".excalidraw");
    canvas?.addEventListener("keydown", () => engine.deleteSelection(), { once: true });
    await act(async () => {
      canvas?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      await vi.advanceTimersByTimeAsync(30);
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(false);
  });
});

it("preserves highlighter identity and only restyles the property the person changed", async () => {
  await withOpenBoard(async (container, engine) => {
    await clickControl(container, "Select");
    await act(async () => engine.select("highlighter"));
    const before = engine.elements()[0];
    await clickControl(container, "Colour: Ink");
    await clickControl(document, "Thick");
    expect(engine.elements()[0]?.strokeWidth).toBeCloseTo((8 * 4) / 4.25);
    expect(engine.elements()[0]?.strokeColor).toBe(before?.strokeColor);
    expect(engine.elements()[0]?.opacity).toBe(40);
    await act(async () => engine.select("note"));
    const note = engine.elements()[0];
    await clickControl(document, "Thin");
    expect(engine.elements()[0]).toEqual(note);
  });
});

it.each([1, 2])("does not place notes for pointer button %s", async (button) => {
  await withOpenBoard(async (container) => {
    await clickControl(container, "Sticky note");
    await act(async () => container.querySelector(".chalk-board-note-layer")?.dispatchEvent(new MouseEvent("pointerdown", { button, bubbles: true })));
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Sticky note"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(true);
  });
});

it("reports a shared clear failure instead of claiming that the board cleared", async () => {
  const original = BoardMenuModule.BoardMenu;
  let clearAction: (() => void) | undefined;
  vi.spyOn(BoardMenuModule, "BoardMenu").mockImplementation((props) => {
    clearAction = props.onClear;
    return original(props);
  });
  await withOpenBoard(async (_container, _engine, peer, toast) => {
    peer.clear.mockRejectedValueOnce(new Error("stale scene"));
    expect(clearAction).toBeTypeOf("function");
    await act(async () => clearAction?.());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "Could not clear the board. Try again." }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ message: "Board cleared" }));
  });
});
