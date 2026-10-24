// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { Board, type BoardProps } from "./Board";
import * as CursorModule from "../../../../../../packages/whiteboard/src/react/board/BoardCursors";
import { SpaceStage } from "../stage/SpaceStage";
import * as BoardMenuModule from "../../../../../../packages/whiteboard/src/react/board/BoardMenu";
import { BoardToastContext } from "../../../../../../packages/whiteboard/src/react/board/board-toasts";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import { ChalkWhiteboardV1Client, type ChalkWhiteboardV1ClientOptions, type Capability, type ChalkWhiteboardView } from "@q9labsai/chalk-client";
import { WhiteboardCanvas, type WhiteboardEngineHandle } from "@q9labsai/chalk-whiteboard/react";

type TestEngine = {
  pan: (x: number, y: number) => void;
  camera: () => { x: number; y: number };
  cameraWrites: () => number;
  logicalWidth: () => number;
  zoom: (value: number) => void;
  editText: (editing: boolean, changed?: boolean) => void;
  select: (kind: "note" | "highlighter") => void;
  elements: () => readonly { strokeColor?: string; strokeWidth?: number; backgroundColor?: string; opacity?: number; isDeleted: boolean }[];
  deleteSelection: () => void;
  draw: () => void;
  nudge: () => void;
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
    const undoButton = document.createElement("button");
    const redoButton = document.createElement("button");
    undoButton.dataset.testid = "button-undo";
    redoButton.dataset.testid = "button-redo";
    undoButton.disabled = redoButton.disabled = true;
    const historyListeners = new Set<() => void>();
    const emitHistory = () => {
      for (const listener of historyListeners) listener();
    };
    const nativeHistory = {
      get isUndoStackEmpty() {
        return undoButton.disabled;
      },
      get isRedoStackEmpty() {
        return redoButton.disabled;
      },
      clear: () => {
        undoButton.disabled = redoButton.disabled = true;
      },
      onHistoryChangedEmitter: {
        on: (listener: () => void) => {
          historyListeners.add(listener);
          return () => {
            historyListeners.delete(listener);
          };
        },
        trigger: emitHistory,
      },
    };
    const actions = new Set<{ keyTest?: (event: KeyboardEvent, state: State, elements: readonly TextElement[], app: { history: typeof nativeHistory }) => boolean }>();
    const record = () => {
      undoButton.disabled = false;
      redoButton.disabled = true;
      emitHistory();
    };
    const clearHistory = () => nativeHistory.clear();
    const changes = new Set<Change>();
    const scrolls = new Set<(x: number, y: number, zoom: { value: number }) => void>();
    const notify = () => {
      for (const listener of changes) listener(elements, appState, {});
    };
    let cameraWrites = 0;
    const api = {
      history: { clear: clearHistory },
      registerAction: (action: Parameters<typeof actions.add>[0]) => {
        actions.add(action);
      },
      getAppState: () => appState,
      getSceneElements: () => elements,
      getSceneElementsIncludingDeleted: () => elements,
      getFiles: () => ({}),
      updateScene: (input: { appState?: Partial<State>; elements?: readonly TextElement[]; captureUpdate?: string }) => {
        if (input.appState && ("scrollX" in input.appState || "scrollY" in input.appState || "zoom" in input.appState)) cameraWrites++;
        if (input.captureUpdate === "IMMEDIATELY") record();
        const before = appState;
        appState = { ...appState, ...input.appState };
        if (input.elements) elements = input.elements;
        if (before.scrollX !== appState.scrollX || before.scrollY !== appState.scrollY || before.zoom.value !== appState.zoom.value) {
          for (const listener of scrolls) listener(appState.scrollX, appState.scrollY, appState.zoom);
        }
        notify();
      },
      setActiveTool: () => undefined,
      scrollToContent: () => api.updateScene({ appState: { scrollX: 2_000_000, scrollY: -2_000_000 } }),
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
        record();
        notify();
      },
      draw: record,
      nudge: record,
      pan: (x, y) => api.updateScene({ appState: { scrollX: x, scrollY: y } }),
      camera: () => ({ x: appState.scrollX, y: appState.scrollY }),
      cameraWrites: () => cameraWrites,
      logicalWidth: () => 1 / appState.zoom.value,
      zoom: (value) => api.updateScene({ appState: { zoom: { value } } }),
      editText: (editing, changed = false) => {
        if (changed) record();
        if (changed) elements = [{ id: "text", type: "text", version: (elements[0]?.version ?? 0) + 1, isDeleted: false }];
        api.updateScene({ appState: { editingTextElement: editing ? { id: "text" } : null } });
      },
    };
    const attach = (element: HTMLDivElement | null) => {
      if (!element) return;
      element.append(undoButton, redoButton);
      element.onkeydown = (event) => {
        for (const action of actions) action.keyTest?.(event, appState, elements, { history: nativeHistory });
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
        if (event.shiftKey && !redoButton.disabled) {
          undoButton.disabled = false;
          redoButton.disabled = true;
        } else if (!event.shiftKey && !undoButton.disabled) {
          undoButton.disabled = true;
          redoButton.disabled = false;
        }
        emitHistory();
      };
    };
    return { api, controls, attach };
  };
  return {
    restoreElements: (elements: readonly TextElement[]) => elements,
    reconcileElements: (local: readonly TextElement[], remote: readonly TextElement[]) => [...local, ...remote],
    isInvisiblySmallElement: () => false,
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
      return createElement("div", { className: "excalidraw", ref: engine.attach });
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
    scene: (sceneId: string, revision: string) => {
      for (const listener of listeners) listener({ type: "snapshot", sceneId, revision, elements: [] });
    },
    cursor: (participantId: string, occurredAt = new Date().toISOString()) => {
      for (const listener of listeners) listener({ type: "cursor", participantId, displayName: participantId, x: 0, y: 0, occurredAt });
    },
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
  [2, false, false, false, false],
  [2, true, false, false, false],
  [2, false, true, false, false],
  [2, true, true, false, false],
  [3, false, false, false, false],
  [3, true, false, false, false],
  [2, false, false, true, false],
  [2, false, false, false, true],
] as const)("%s cyclic followers settle after crossed 50 ms updates: reduced %s, different shapes %s, legacy %s, zoom %s", async (count, reduced, differentShapes, legacy, zoomLeader) => {
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
      if (zoomLeader && view.lead === false) return true;
      const frame = legacy ? { x: view.x, y: view.y, width: view.width, height: view.height, bring: view.bring } : view.originParticipantId ? view : { ...view, originParticipantId: String(index), originEpoch: "initial", originSequence: (sequences[index] = (sequences[index] ?? 0) + 1) };
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
    if (zoomLeader) {
      await act(async () => render(0, false));
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.click();
        await vi.advanceTimersByTimeAsync(1_200);
      });
      expect(engines[0]?.logicalWidth()).toBeCloseTo(0.8, 5);
      expect(engines[1]?.logicalWidth()).toBeCloseTo(engines[0]?.logicalWidth() ?? 0, 5);
      expect(sends[0]).toHaveBeenLastCalledWith(expect.objectContaining({ width: 0.8, lead: true }));
    }
    const settled = engines.map((engine) => engine.camera());
    sends.forEach((send) => send.mockClear());
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    sends.forEach((send) => (zoomLeader ? expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ lead: true })) : expect(send).not.toHaveBeenCalled()));
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
      const frame = { ...view, ownerId: "owner", ownerSequence: (sequences[index] = (sequences[index] ?? 0) + 1) };
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
      peers[2]?.receive("1", { ...latest, x: 999, ownerId: "owner", ownerSequence: (sequences[1] ?? 1) - 1 });
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(follower.camera()).toEqual(settled);
    expect(sends[2]).not.toHaveBeenCalledWith(expect.objectContaining({ x: 999 }));
    await act(async () => {
      peers[1]?.receive("0", { ...latest, x: 432, ownerId: "owner", ownerSequence: (sequences[0] ?? 0) + 1 });
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(follower.camera().x).toBeCloseTo(-432, 2);
    sends[2]?.mockClear();
    await act(async () => {
      peers[1]?.receive("0", { ...latest, x: 999, ownerId: "owner", ownerSequence: 1 });
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(follower.camera().x).toBeCloseTo(-432, 2);
    expect(sends[2]).not.toHaveBeenCalledWith(expect.objectContaining({ x: 999 }));
    await act(async () => {
      peers[1]?.receive("0", { ...latest, x: 456, ownerId: "owner", ownerSequence: 1000 });
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(follower.camera().x).toBeCloseTo(-456, 2);
    await act(async () => {
      peers[1]?.receive("0", { ...latest, x: 789, ownerId: "owner", ownerSequence: 1001 });
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(follower.camera().x).toBeCloseTo(-789, 2);
  } finally {
    await act(async () => roots.forEach((root) => root.unmount()));
    container.remove();
    clients.forEach((client) => client.dispose());
  }
});

it("ignores unchanged owner refreshes without camera writes or relay echoes", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  const send = vi.fn(() => true);
  await withOpenBoard(
    async (_container, engine, peer) => {
      const view = { x: 432, y: 0, width: 100, height: 100, bring: false, ownerId: "owner", ownerSequence: 1 };
      await act(async () => {
        peer.receive("remote", view);
        await vi.advanceTimersByTimeAsync(600);
      });
      const before = engine.camera(),
        writes = engine.cameraWrites();
      send.mockClear();
      for (let tick = 0; tick < 6; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
          peer.receive("remote", view);
          await vi.advanceTimersByTimeAsync(200);
        });
      }
      expect(engine.camera()).toEqual(before);
      expect(engine.cameraWrites()).toBe(writes);
      expect(send).not.toHaveBeenCalled();
    },
    true,
    { sendView: send },
  );
});

it("cancels an older glide when the newest owner view returns to the current camera", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  await withOpenBoard(async (_container, engine, peer) => {
    const view = { x: 432, y: 0, width: 100, height: 100, bring: false, ownerId: "owner", ownerSequence: 1 };
    await act(async () => {
      peer.receive("remote", view);
      await vi.advanceTimersByTimeAsync(600);
    });
    const baseline = engine.camera(),
      writes = engine.cameraWrites();
    await act(async () => {
      peer.receive("remote", { ...view, x: 999, ownerSequence: 2 });
      peer.receive("remote", { ...view, ownerSequence: 3 });
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(engine.camera()).toEqual(baseline);
    expect(engine.cameraWrites()).toBe(writes);
  });
});

it("preserves a legacy relay's original person and tab epoch after Bring", async () => {
  vi.useFakeTimers();
  const peer = createPeer();
  const client = participantClient("follower");
  const sendView = vi.fn(() => true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <Board board={peer.board} primary visible colorScheme="dark" people={[]} following="relay" onFollow={() => undefined} sendView={sendView} />
        </ChalkProvider>,
      ),
    );
    await finishOpening(container);
    await act(async () => {
      peer.receive("relay", { x: 123, y: 0, width: 100, height: 100, bring: true, originParticipantId: "origin", originSequence: 7, originEpoch: "tab-a" });
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(sendView).toHaveBeenLastCalledWith(expect.objectContaining({ x: 123, bring: false, originParticipantId: "origin", originSequence: 7, originEpoch: "tab-a" }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it.each([
  ["relay", "origin"],
  ["origin", "relay"],
])("keeps direct reconnect history after %s then %s delivery", async (first, second) => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const peer = createPeer();
  const client = participantClient("follower");
  const sendView = vi.fn(() => true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (following: string) =>
    root.render(
      <ChalkProvider client={client}>
        <Board board={peer.board} primary visible colorScheme="dark" people={[]} following={following} onFollow={() => undefined} sendView={sendView} />
      </ChalkProvider>,
    );
  try {
    await act(async () => render("relay"));
    await finishOpening(container);
    const [follower] = loadedEngines();
    if (!follower) throw new Error("Follower must be initialized");
    const view = { x: 100, y: 0, width: 100, height: 100, bring: false, originParticipantId: "origin", originSequence: 100, ownerId: "owner", ownerSequence: 100 };
    for (const publisher of [first, second])
      await act(async () => {
        peer.receive(publisher, view);
        await vi.advanceTimersByTimeAsync(400);
      });
    await act(async () => render("origin"));
    const reconnected = { ...view, x: 432, originSequence: 101, ownerSequence: 101 };
    await act(async () => {
      peer.receive("origin", reconnected);
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(sendView).toHaveBeenLastCalledWith(expect.objectContaining({ x: 432, lead: true, originParticipantId: "origin", originSequence: 101 }));
    const current = follower.camera();
    await act(async () => {
      peer.receive("origin", { ...view, x: 999, ownerSequence: 100 });
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(follower.camera()).toEqual(current);
    await act(async () => {
      peer.receive("origin", { ...reconnected, x: 456, ownerSequence: 102 });
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(follower.camera()).not.toEqual(current);
    expect(sendView).toHaveBeenLastCalledWith(expect.objectContaining({ x: 456, lead: false, originParticipantId: "origin", originSequence: 102 }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
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

it.each(["other", "screen-share:other"])("follows on the first click after pinning %s and makes Board primary", async (pinned) => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const tiles = [
    { id: "self", displayName: "Amina", isLocal: true },
    { id: "other", displayName: "Omar", isScreenSharing: true },
  ];
  const render = async (isOpen: boolean) =>
    act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceStage tiles={tiles} layout="focus" generatedAvatars={false} whiteboard={{ isOpen, props: {}, sendView: () => true }} />
        </ChalkProvider>,
      ),
    );
  try {
    await render(false);
    await act(async () => container.querySelector<HTMLElement>(`[data-stage-item="${pinned}"] button`)?.click());
    await render(true);
    await finishOpening(container);
    const follow = container.querySelector<HTMLElement>('[aria-label="Follow Omar"]');
    expect(follow).not.toBeNull();
    await act(async () => follow?.click());
    expect(container.querySelector('[data-stage-item="other"]')?.textContent).toContain("following");
    expect(container.querySelector('[data-stage-item="whiteboard"]')?.getAttribute("data-stage-role")).toBe("primary");
    await act(async () => container.querySelector<HTMLElement>('[data-stage-item="screen-share:other"] button')?.click());
    expect(container.querySelector('[data-stage-item="screen-share:other"]')?.getAttribute("data-stage-role")).toBe("primary");
    await render(false);
    await act(async () => container.querySelector<HTMLElement>('[data-stage-item="other"] button')?.click());
    expect(container.querySelector('[data-stage-item="other"]')?.getAttribute("data-stage-role")).toBe("primary");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("returns to the followed board when an explicitly pinned remote share ends", async () => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (sharing: boolean) =>
    act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceStage
            tiles={[
              { id: "self", displayName: "Amina", isLocal: true, isScreenSharing: true },
              { id: "other", displayName: "Omar", isScreenSharing: sharing },
            ]}
            layout="focus"
            generatedAvatars={false}
            whiteboard={{ isOpen: true, props: {}, sendView: () => true }}
          />
        </ChalkProvider>,
      ),
    );
  try {
    await render(true);
    await finishOpening(container);
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Follow Omar"]')?.click());
    expect(container.querySelector('[data-stage-item="whiteboard"]')?.getAttribute("data-stage-role")).toBe("primary");
    await act(async () => container.querySelector<HTMLElement>('[data-stage-item="screen-share:other"] button')?.click());
    expect(container.querySelector('[data-stage-item="screen-share:other"]')?.getAttribute("data-stage-role")).toBe("primary");
    await render(false);
    expect(container.querySelector('[data-stage-item="other"]')?.textContent).toContain("following");
    expect(container.querySelector('[data-stage-item="whiteboard"]')?.getAttribute("data-stage-role")).toBe("primary");
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
  vi.stubGlobal("localStorage", window.localStorage);
  window.localStorage.clear();
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

it.each(["load", "error"])("waits for the engine stylesheet and surfaces its %s outcome", async (outcome) => {
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
      const engine = container.querySelector(".chalk-board-engine");
      const loading = container.querySelector(".chalk-board-loading");
      if (!(engine instanceof HTMLElement) || !(loading instanceof HTMLElement)) throw new Error("Missing board loading layers");
      expect(getComputedStyle(engine).opacity).not.toBe("0");
      expect(getComputedStyle(loading).display).toBe("none");
      expect(engine.querySelector('[role="alert"]')?.textContent).toContain("Failed to load");
      expect(container.querySelector(".chalk-board")?.hasAttribute("data-ready")).toBe(false);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

async function withOpenBoard(
  check: (container: HTMLElement, engine: TestEngine, peer: ReturnType<typeof createPeer>, toast: ReturnType<typeof vi.fn>, render: (props: Partial<Pick<BoardProps, "primary" | "visible" | "following" | "people">> | null) => Promise<void>) => Promise<void>,
  primary = true,
  options: {
    capabilities?: readonly Capability[];
    canDraw?: boolean;
    phone?: boolean;
    presentation?: BoardProps["presentation"];
    sendView?: (view: ChalkWhiteboardView) => boolean;
    onFollow?: BoardProps["onFollow"];
    onClose?: BoardProps["onClose"];
    onClient?: (client: ReturnType<typeof createPreviewClient>) => void;
  } = {},
) {
  const client = createPreviewClient(createSnapshot(options.capabilities ?? ["drawWhiteboard", "manageWhiteboard"]));
  options.onClient?.(client);
  const peer = createPeer();
  const board = { ...peer.board, collab: { ...peer.board.collab, canDraw: options.canDraw ?? true } };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const toast = vi.fn();
  function OpenBoard(props: Partial<Pick<BoardProps, "primary" | "visible" | "following" | "people">>) {
    const [following, setFollowing] = useState<string | null>("remote");
    return (
      <Board
        board={board}
        primary={primary}
        visible
        phone={options.phone}
        presentation={options.presentation}
        onClose={options.onClose}
        colorScheme="dark"
        people={[]}
        following={following}
        onFollow={(id) => {
          setFollowing(id);
          options.onFollow?.(id);
        }}
        sendView={options.sendView ?? (() => true)}
        {...props}
      />
    );
  }
  const render = async (props: Partial<Pick<BoardProps, "primary" | "visible" | "following" | "people">> | null = {}) => {
    await act(async () =>
      root.render(
        props === null ? null : (
          <ChalkProvider client={client}>
            <BoardToastContext value={toast}>
              <OpenBoard {...props} />
            </BoardToastContext>
          </ChalkProvider>
        ),
      ),
    );
  };
  try {
    await render();
    await finishOpening(container);
    const engine = loadedEngines()[0];
    if (!engine) throw new Error("Missing board engine");
    await check(container, engine, peer, toast, render);
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

it("keeps following when a Bring animation's first frame predates its start", async () => {
  vi.useFakeTimers();
  const onFollow = vi.fn();
  await withOpenBoard(
    async (container, engine, peer) => {
      await act(async () => engine.zoom(3));
      onFollow.mockClear();
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now() - 100), 16));
      vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
      await act(async () => {
        peer.receive("presenter", { x: 0, y: 0, width: 10, height: 10, bring: true });
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(container.querySelector(".chalk-board-chip")?.textContent ?? "").toContain("Following Someone");
      expect(container.querySelector(".chalk-board-zoom-value")?.textContent).toBe("10%");
      expect(onFollow).not.toHaveBeenCalledWith(null);
    },
    true,
    { onFollow },
  );
});

it("separates guest mobile export and Close board actions once", async () => {
  await withOpenBoard(
    async (container) => {
      await clickControl(container, "Board menu");
      const menu = container.querySelector('[role="menu"]');
      expect(menu?.textContent).toContain("Close board");
      const roles = [...(menu?.querySelectorAll('[role="separator"], [role="menuitem"]') ?? [])].map((item) => item.getAttribute("role"));
      expect(roles.join("|")).not.toContain("separator|separator");
    },
    true,
    { phone: true, presentation: "mobile", capabilities: ["drawWhiteboard"], onClose: () => undefined },
  );
});

it("receives Bring while the board tile is off-page and keeps that view on return", async () => {
  vi.useFakeTimers();
  const onFollow = vi.fn();
  const sizes = new Map<Element, ((width: number, height: number) => void)[]>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: (entries: { contentRect: { width: number; height: number } }[]) => void) {}
      observe(element: Element) {
        sizes.set(element, [...(sizes.get(element) ?? []), (width, height) => this.callback([{ contentRect: { width, height } }])]);
      }
      disconnect() {}
    },
  );
  await withOpenBoard(
    async (container, engine, peer, toast, render) => {
      const resize = (width: number, height: number) => sizes.get(container.querySelector(".chalk-board")!)?.forEach((callback) => callback(width, height));
      await render({ visible: false });
      await act(async () => resize(0, 0));
      toast.mockClear();
      await act(async () => {
        peer.receive("presenter", { x: 75, y: 25, width: 400, height: 300, bring: true });
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(onFollow).toHaveBeenCalledWith("presenter");
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Someone brought everyone to this view" }));
      await render({ visible: true });
      await act(async () => {
        resize(800, 600);
        await vi.advanceTimersByTimeAsync(600);
      });
      // cameraForView fits the 400x300 sender into 800x600 at zoom 2.
      expect(engine.camera().x).toBeCloseTo(-75, 2);
      await act(async () => engine.pan(12, 34));
      expect(onFollow).toHaveBeenLastCalledWith(null);
    },
    true,
    { onFollow },
  );
});

it.each([false, true])("standalone Clear Undo survives callback changes but not unmount, unmount %s", async (unmount) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current: WhiteboardEngineHandle | undefined;
  const render = () =>
    root.render(
      <WhiteboardCanvas
        onEngineReady={(engine) => {
          current = engine;
        }}
      />,
    );
  try {
    await act(async () => render());
    await vi.waitFor(() => expect(loadedEngines()).toHaveLength(1));
    await act(async () => document.getElementById("chalk-excalidraw-styles")?.dispatchEvent(new Event("load")));
    await vi.waitFor(() => expect(current).toBeDefined());
    const engine = loadedEngines()[0];
    if (!engine || !current) throw new Error("Standalone board must be ready");
    await act(async () => engine.select("stroke"));
    const restore = await act(async () => current?.clearWithUndo());
    if (!restore) throw new Error("Clear must return Undo");
    await act(async () => (unmount ? root.render(null) : render()));
    await act(async () => expect(restore()).toBe(!unmount));
    expect(engine.elements()).toHaveLength(unmount ? 0 : 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["new empty scene", "new empty revision", "disposed"])("refuses Clear Undo after %s", async (change) => {
  const menu = observeBoardMenu();
  await withOpenBoard(async (_container, engine, peer, toast, render) => {
    await act(async () => engine.select("stroke"));
    await act(async () => menu.clear?.());
    const action = toast.mock.calls.find(([value]) => value?.message === "Board cleared")?.[0].action;
    expect(action).toBeDefined();
    if (change === "disposed") await render(null);
    else await act(async () => peer.scene(change === "new empty scene" ? "next" : "scene", "2"));
    await act(async () => action.onClick());
    expect(engine.elements()).toHaveLength(0);
  });
});

it("restores Clear Undo before a subsequent scene change", async () => {
  const menu = observeBoardMenu();
  await withOpenBoard(async (_container, engine, _peer, toast) => {
    await act(async () => engine.select("stroke"));
    await act(async () => menu.clear?.());
    const action = toast.mock.calls.find(([value]) => value?.message === "Board cleared")?.[0].action;
    expect(action).toBeDefined();
    await act(async () => action.onClick());
    expect(engine.elements()).toHaveLength(1);
  });
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

it("reflects an actual keyboard deletion of existing scene content", async () => {
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

function observeBoardMenu() {
  const menu: { clear?: () => void } = {};
  const original = BoardMenuModule.BoardMenu;
  vi.spyOn(BoardMenuModule, "BoardMenu").mockImplementation((props) => {
    menu.clear = props.onClear;
    return original(props);
  });
  return menu;
}

it("reports a shared clear failure instead of claiming that the board cleared", async () => {
  const menu = observeBoardMenu();
  await withOpenBoard(async (_container, _engine, peer, toast) => {
    peer.clear.mockRejectedValueOnce(new Error("stale scene"));
    expect(menu.clear).toBeTypeOf("function");
    await act(async () => menu.clear?.());
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "Could not clear the board. Try again." }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ message: "Board cleared" }));
  });
});

it.each(["draw", "nudge", "delete", "restyle"])("reads engine history after %s, including edits to remote content", async (kind) => {
  await withOpenBoard(async (container, engine) => {
    if (kind === "draw") await act(async () => engine.draw());
    if (kind === "nudge") await act(async () => engine.nudge());
    if (kind === "delete") await act(async () => engine.deleteSelection());
    if (kind === "restyle") {
      await act(async () => engine.select("highlighter"));
      await clickControl(container, "Colour: Ink");
      await clickControl(document, "Red");
    }
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(false);
    await clickControl(container, "Undo");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')?.disabled).toBe(false);
  });
});

it.each(["local", "legacy"])("accepts %s Bring even when its person is self", async (kind) => {
  vi.useFakeTimers();
  const onFollow = vi.fn();
  await withOpenBoard(
    async (_container, _engine, peer, toast) => {
      const person = kind === "local" ? "participant-local" : "presenter";
      await act(async () => peer.receive(person, { x: 25, y: 25, width: 100, height: 100, bring: true, originParticipantId: "participant-local", originSequence: 1 }));
      expect(onFollow).toHaveBeenCalledWith(person);
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Someone brought everyone to this view" }));
    },
    true,
    { onFollow, onClient: (client) => client.updateSnapshot((snapshot) => ({ ...snapshot, self: { ...snapshot.self, participantId: "participant-local" } })) },
  );
});

it("processes Bring even after the same origin version was applied through a relay", async () => {
  vi.useFakeTimers();
  await withOpenBoard(async (_container, _engine, peer, toast) => {
    const view = { x: 25, y: 25, width: 1, height: 1, bring: false, originParticipantId: "presenter", originEpoch: "epoch", originSequence: 1 };
    await act(async () => {
      peer.receive("remote", view);
      await vi.advanceTimersByTimeAsync(600);
    });
    await act(async () => peer.receive("presenter", { ...view, bring: true }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: "Someone brought everyone to this view" }));
  });
});

it("keeps overflowed people followable when the host supplies a Participants panel", async () => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const openParticipants = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceStage tiles={Array.from({ length: 30 }, (_, index) => ({ id: `person-${index}`, displayName: `Person ${index}`, isLocal: index === 0 }))} layout="focus" generatedAvatars={false} whiteboard={{ isOpen: true, props: {}, sendView: () => true }} onOverflowClick={openParticipants} />
        </ChalkProvider>,
      ),
    );
    await finishOpening(container);
    const overflow = container.querySelector<HTMLButtonElement>('button[aria-label^="Show "][aria-label$="more participants"]');
    expect(overflow).not.toBeNull();
    await act(async () => overflow?.click());
    expect(openParticipants).not.toHaveBeenCalled();
    const follow = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Follow Person 29");
    expect(follow).toBeDefined();
    await act(async () => follow?.click());
    expect(container.textContent).toContain("Following Person");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("clears engine Undo and Redo after clear, and records only the guarded restore", async () => {
  const menu = observeBoardMenu();
  await withOpenBoard(async (container, engine, _peer, toast) => {
    await act(async () => engine.draw());
    await clickControl(container, "Undo");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')?.disabled).toBe(false);
    await act(async () => menu.clear?.());
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Redo"]')?.disabled).toBe(true);
    const cleared = toast.mock.calls.find(([value]) => value?.message === "Board cleared")?.[0];
    await act(async () => cleared?.action?.onClick());
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]')?.disabled).toBe(false);
  });
});

it("sends bounded views after remote pans and fitting distant content", async () => {
  vi.useFakeTimers();
  const send = vi.fn((view: ChalkWhiteboardView) => {
    if (Math.abs(view.x) > 1_000_000 || Math.abs(view.y) > 1_000_000) throw new Error("invalid view frame");
    return true;
  });
  await withOpenBoard(
    async (container, engine) => {
      for (const coordinate of [-2_000_000, 2_000_000]) {
        await act(async () => {
          engine.pan(coordinate, -coordinate);
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ x: -Math.sign(coordinate) * 1_000_000, y: Math.sign(coordinate) * 1_000_000 }));
      }
      await clickControl(container, "Fit to content");
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ x: -1_000_000, y: 1_000_000 }));
    },
    true,
    { sendView: send },
  );
});

it("drops and reports a rejected scheduled view instead of throwing", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const send = vi.fn(() => true);
  await withOpenBoard(
    async (_container, engine) => {
      send.mockImplementationOnce(() => {
        throw new Error("invalid view frame");
      });
      await act(async () => {
        engine.pan(100, 100);
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(warning).toHaveBeenCalledWith("Board view dropped.", expect.objectContaining({ operation: "sendView" }));
    },
    true,
    { sendView: send },
  );
});

it.each(["capacity", "expiry"])("prunes the cursor cache by %s without a mounted cursor layer", async (kind) => {
  vi.useFakeTimers();
  const layer = vi.spyOn(CursorModule, "BoardCursors").mockImplementation(() => null);
  await withOpenBoard(async (_container, _engine, peer, _toast, render) => {
    await act(async () => {
      if (kind === "capacity") for (let index = 0; index < 300; index++) peer.cursor(String(index));
      else {
        peer.cursor("expired");
        await vi.advanceTimersByTimeAsync(11_000);
        peer.cursor("fresh");
      }
    });
    expect(layer).not.toHaveBeenCalled();
    await render({ primary: true });
    const cache = layer.mock.lastCall?.[0].cursorsRef.current;
    expect(cache?.size).toBe(kind === "capacity" ? 256 : 1);
    expect(cache?.has(kind === "capacity" ? "0" : "expired")).toBe(false);
  }, false);
});

it("allows a manage-only custom role to clear without drawing", async () => {
  const menu = observeBoardMenu();
  await withOpenBoard(
    async (_container, _engine, peer, toast) => {
      expect(menu.clear).toBeTypeOf("function");
      await act(async () => menu.clear?.());
      expect(peer.clear).toHaveBeenCalledOnce();
      expect(toast).toHaveBeenCalledWith({ message: "Board cleared" });
    },
    true,
    { capabilities: ["manageWhiteboard"], canDraw: false },
  );
});

it("drops board action toasts when the board closes", async () => {
  await withOpenBoard(async (_container, _engine, _peer, toast, render) => {
    toast.mockClear();
    await render(null);
    expect(toast).toHaveBeenCalledWith(null);
  });
});

it("ignores a clear completion after the board lifetime ends", async () => {
  const menu = observeBoardMenu();
  await withOpenBoard(async (_container, _engine, peer, toast, render) => {
    let resolve: ((commit: { sceneId: string; revision: string }) => void) | undefined;
    peer.clear.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => menu.clear?.());
    await render(null);
    toast.mockClear();
    await act(async () => resolve?.({ sceneId: "cleared", revision: "2" }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ message: "Board cleared" }));
  });
});

it("does not resurrect an ended share pin when the same person shares again", async () => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (sharing: boolean) =>
    act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceStage
            tiles={[
              { id: "self", displayName: "Amina", isLocal: true },
              { id: "other", displayName: "Omar", isScreenSharing: sharing },
            ]}
            layout="focus"
            generatedAvatars={false}
            whiteboard={{ isOpen: true, props: {}, sendView: () => true }}
          />
        </ChalkProvider>,
      ),
    );
  try {
    await render(true);
    await finishOpening(container);
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Follow Omar"]')?.click());
    expect(container.querySelector('[data-stage-item="whiteboard"]')?.getAttribute("data-stage-role")).toBe("primary");
    await act(async () => container.querySelector<HTMLElement>('[data-stage-item="screen-share:other"] button')?.click());
    expect(container.querySelector('[data-stage-item="screen-share:other"]')?.getAttribute("data-stage-role")).toBe("primary");
    await render(true);
    expect(container.querySelector('[data-stage-item="screen-share:other"]')?.getAttribute("data-stage-role")).toBe("primary");
    await render(false);
    expect(container.querySelector('[data-stage-item="other"]')?.textContent).toContain("following");
    expect(container.querySelector('[data-stage-item="whiteboard"]')?.getAttribute("data-stage-role")).toBe("primary");
    await render(true);
    expect(container.querySelector('[data-stage-item="other"]')?.textContent).toContain("following");
    expect(container.querySelector('[data-stage-item="whiteboard"]')?.getAttribute("data-stage-role")).toBe("primary");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("does not resurrect an ended screen-switcher choice when the same person shares again", async () => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (sharing: boolean) =>
    act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceStage
            tiles={[
              { id: "self", displayName: "Amina", isLocal: true, isScreenSharing: true },
              { id: "other", displayName: "Omar", isScreenSharing: sharing },
            ]}
            layout="focus"
            generatedAvatars={false}
            whiteboard={{ isOpen: true, props: {}, sendView: () => true }}
          />
        </ChalkProvider>,
      ),
    );
  try {
    await render(true);
    await finishOpening(container);
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Follow Omar"]')?.click());
    expect(container.querySelector('[data-stage-item="whiteboard"]')?.getAttribute("data-stage-role")).toBe("primary");
    await act(async () => container.querySelector<HTMLElement>('[data-stage-item="screen-share:self"] button')?.click());
    const switcher = container.querySelector('[data-stage-item="screen-share:self"] [aria-label="Whose screen is big"]');
    const chooseOmar = [...(switcher?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Omar");
    expect(chooseOmar).toBeDefined();
    await act(async () => chooseOmar?.click());
    expect(container.querySelector('[data-stage-item="screen-share:other"]')?.getAttribute("data-stage-role")).toBe("primary");
    await render(true);
    expect(container.querySelector('[data-stage-item="screen-share:other"]')?.getAttribute("data-stage-role")).toBe("primary");
    await render(false);
    expect(container.querySelector('[data-stage-item="other"]')?.textContent).toContain("following");
    expect(container.querySelector('[data-stage-item="whiteboard"]')?.getAttribute("data-stage-role")).toBe("primary");
    await render(true);
    expect(container.querySelector('[data-stage-item="other"]')?.textContent).toContain("following");
    expect(container.querySelector('[data-stage-item="whiteboard"]')?.getAttribute("data-stage-role")).toBe("primary");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.dispose();
  }
});

it("automatic first-content fit follows the default camera leadership rule", async () => {
  vi.useFakeTimers();
  const send = vi.fn(() => true);
  await withOpenBoard(
    async (_container, engine, _peer, _toast, render) => {
      await render({ following: null });
      send.mockClear();
      await act(async () => {
        engine.select("note");
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ lead: true }));
    },
    true,
    { sendView: send },
  );
});

it("discovery and idle refreshes preserve a coalesced real leadership intent", async () => {
  vi.useFakeTimers();
  const send = vi.fn(() => true);
  await withOpenBoard(
    async (_container, engine, peer, _toast, render) => {
      await render({ following: null });
      await act(async () => vi.advanceTimersByTimeAsync(200));
      send.mockClear();
      await act(async () => {
        engine.pan(10, 20);
        peer.receive("new-peer", { x: 50, y: 0, width: 100, height: 100, bring: false });
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ lead: true }));
      send.mockClear();
      await act(async () => vi.advanceTimersByTimeAsync(2200));
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ lead: true }));
    },
    true,
    { sendView: send },
  );
});

const cameraMoveCases: readonly { name: string; follow?: true; run: (container: HTMLElement, engine: TestEngine, peer: { receive: (id: string, view: ChalkWhiteboardView) => void }) => void }[] = [
  { name: "engine pan", run: (_container, engine) => engine.pan(25, 30) },
  { name: "engine wheel/pinch zoom", run: (_container, engine) => engine.zoom(1.5) },
  { name: "engine zoom beyond its clamp", run: (_container, engine) => engine.zoom(99) },
  ...["Zoom in", "Zoom out", "Zoom 125%, reset to 100%", "Fit to content"].map((label) => ({
    name: label,
    run: (container: HTMLElement) =>
      (() => {
        const button = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
        if (!button) throw new Error(`Missing ${label}`);
        button.click();
      })(),
  })),
  ...["+", "=", "-"].map((key) => ({
    name: `keyboard ${key}`,
    run: (container: HTMLElement) =>
      (() => {
        const board = container.querySelector(".chalk-board");
        if (!board) throw new Error("Missing board");
        board.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      })(),
  })),
  { name: "first-content fit", run: (_container, engine) => engine.select("note") },
  { name: "follow apply", follow: true, run: (_container, _engine, peer) => peer.receive("remote", { x: 200, y: 0, width: 100, height: 100, bring: false, originParticipantId: "remote", originEpoch: "camera-table", originSequence: 2 }) },
];
it.each(cameraMoveCases)("camera API leadership: $name", async ({ follow, run }) => {
  vi.useFakeTimers();
  const send = vi.fn(() => true);
  await withOpenBoard(
    async (container, engine, peer, _toast, render) => {
      await render({ following: null });
      await act(async () => {
        engine.zoom(1.25);
        await vi.advanceTimersByTimeAsync(600);
      });
      if (follow) {
        await act(async () => {
          peer.receive("remote", { x: 100, y: 0, width: 100, height: 100, bring: false, originParticipantId: "remote", originEpoch: "camera-table", originSequence: 1 });
        });
        await render({ following: "remote" });
        await act(async () => vi.advanceTimersByTimeAsync(400));
      }
      send.mockClear();
      await act(async () => {
        run(container, engine, peer);
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(send).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ lead: !follow }));
      if (follow) expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ lead: true }));
      else expect(send).toHaveBeenCalledWith(expect.objectContaining({ lead: true }));
    },
    true,
    { sendView: send },
  );
});

it("JUDGE: user Zoom in grants leadership", async () => {
  vi.useFakeTimers();
  const send = vi.fn(() => true);
  await withOpenBoard(
    async (container, _engine, _peer, _toast, render) => {
      await render({ following: null });
      await act(async () => vi.advanceTimersByTimeAsync(250));
      send.mockClear();
      await clickControl(container, "Zoom in");
      await act(async () => vi.advanceTimersByTimeAsync(600));
      expect(send).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ lead: true }));
    },
    true,
    { sendView: send },
  );
});

it("review repro: queued initial fit must not cancel a newer Bring", async () => {
  vi.useFakeTimers();
  const onFollow = vi.fn();
  await withOpenBoard(
    async (_container, engine, peer) => {
      await act(async () => engine.pan(25, 30));
      onFollow.mockClear();
      await act(async () => {
        engine.select("note");
        peer.receive("presenter", { x: 75, y: 25, width: 100, height: 100, bring: true });
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(onFollow).toHaveBeenLastCalledWith("presenter");
    },
    true,
    { onFollow },
  );
});

it.each([2, 500])("follows an idle leader with %i active views", async (count) => {
  vi.useFakeTimers();
  await withOpenBoard(async (_container, engine, peer, _toast, render) => {
    await render({ following: null });
    await act(async () => vi.advanceTimersByTimeAsync(2200));
    await act(async () => {
      for (let index = 0; index < count; index++) peer.receive(`active-${index}`, { x: 432 + index, y: 25, width: 1, height: 1, bring: false, ownerId: "owner", ownerSequence: 1 });
    });
    await render({ following: "active-0" });
    await act(async () => vi.advanceTimersByTimeAsync(2200));
    expect(engine.camera().x).toBeCloseTo(-432, 2);
  }, true);
});

it("keeps the dockable island available on a wide native tablet", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly onResize: (entries: readonly { contentRect: { width: number; height: number } }[]) => void) {}
      observe() {
        this.onResize([{ contentRect: { width: 1200, height: 900 } }]);
      }
      disconnect() {}
    },
  );
  await withOpenBoard(
    async (container) => {
      expect(container.querySelector('.chalk-board-island[data-place="bottom"]')).not.toBeNull();
      const island = container.querySelector('[role="toolbar"][aria-label="Drawing tools"]');
      expect([...island!.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Pen", "Shapes", "Text", "Sticky note", "Eraser", "Colour: Ink", "Undo", "Redo", "Select", "Hand", "Highlighter", "Laser pointer"]);
      await clickControl(container, "Board menu");
      const positions = container.querySelector('[aria-label="Tool island"]');
      expect([...(positions?.querySelectorAll('[role="menuitemradio"]') ?? [])].map((item) => item.textContent?.replace("✓", ""))).toEqual(["Top", "Bottom", "Left"]);
      expect(positions?.querySelector(".chalk-board-tile-preview")).toBeNull();
      const left = [...container.querySelectorAll<HTMLElement>(".chalk-board-tile")].find((item) => item.textContent === "Left");
      expect(left).toBeDefined();
      await act(async () => left?.click());
      expect(container.querySelector('.chalk-board-island[data-place="left"]')).not.toBeNull();
    },
    true,
    { phone: false, presentation: "mobile" },
  );
});

it.each(["mobile", "web"] as const)("compacts a narrow %s tablet board without losing secondary tools", async (presentation) => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly onResize: (entries: readonly { contentRect: { width: number; height: number } }[]) => void) {}
      observe() {
        this.onResize([{ contentRect: { width: 560, height: 900 } }]);
      }
      disconnect() {}
    },
  );
  await withOpenBoard(
    async (container) => {
      expect(container.querySelector('.chalk-board-island[data-place="compact"]')).not.toBeNull();
      await clickControl(container, "Drawing tools");
      expect(container.querySelector('[role="toolbar"][data-place="expanded"]')).not.toBeNull();
      for (const label of ["Select", "Hand", "Highlighter", "Laser pointer"]) {
        await clickControl(container, label);
        expect(container.querySelector(`[aria-label="${label}"]`)?.getAttribute("aria-pressed")).toBe("true");
      }
    },
    true,
    { phone: presentation === "mobile" ? false : undefined, presentation },
  );
});
