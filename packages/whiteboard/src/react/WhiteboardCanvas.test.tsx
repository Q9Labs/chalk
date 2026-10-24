// @vitest-environment jsdom
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import type { WhiteboardCollaborationEvent } from "../collab/engine";
import { WhiteboardCanvas, type WhiteboardCollaborationOptions } from "./index";

type FakeApi = ReturnType<typeof createApi>;

const fake = vi.hoisted(() => ({
  instances: [] as { readonly api: FakeApi; mounted: boolean }[],
  gate: null as Promise<void> | null,
}));

function createApi() {
  const appState = { isLoading: false, viewBackgroundColor: "transparent", scrollX: 0, scrollY: 0, zoom: { value: 1 }, editingTextElement: null, newElement: null, resizingElement: null };
  return {
    getAppState: () => appState,
    getSceneElements: () => [],
    getSceneElementsIncludingDeleted: () => [],
    getFiles: () => ({}),
    addFiles: vi.fn(),
    updateScene: vi.fn(),
    history: { clear: vi.fn() },
    onPointerUp: () => () => undefined,
  };
}

// Excalidraw cannot draw in a DOM runner. The stand-in keeps the one behaviour under test: like the real
// component, it hands over its API from its class constructor, while React is still rendering.
vi.mock("@excalidraw/excalidraw", async () => {
  const { Component, createElement, Fragment, use } = await import("react");
  class Editor extends Component<{ readonly excalidrawAPI: (api: FakeApi) => void }> {
    readonly instance = { api: createApi(), mounted: false };
    constructor(props: { readonly excalidrawAPI: (api: FakeApi) => void }) {
      super(props);
      fake.instances.push(this.instance);
      props.excalidrawAPI(this.instance.api);
    }
    override componentDidMount() {
      this.instance.mounted = true;
    }
    override render() {
      return null;
    }
  }
  // Suspends the render that built an editor, so React throws that editor away and builds another.
  function Gate() {
    if (fake.gate) use(fake.gate);
    return null;
  }
  return {
    CaptureUpdateAction: { NEVER: "NEVER", IMMEDIATELY: "IMMEDIATELY" },
    MIME_TYPES: { binary: "application/octet-stream" },
    isInvisiblySmallElement: () => false,
    newElementWith: <T extends object>(element: T, update: Partial<T>) => ({ ...element, ...update }),
    reconcileElements: (_local: readonly object[], remote: readonly object[]) => [...remote],
    restoreElements: (elements: readonly object[]) => [...elements],
    Excalidraw: (props: { readonly excalidrawAPI: (api: FakeApi) => void }) => createElement(Fragment, null, createElement(Editor, props), createElement(Gate)),
  };
});

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Loaded once up front, so the engine is ready to start while the first editor is still in hand.
  await import("../collab/engine");
});

afterEach(() => {
  fake.instances.length = 0;
  fake.gate = null;
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

it("starts collaboration on the editor React commits, not on one it discarded", async () => {
  let release: () => void = () => undefined;
  fake.gate = new Promise<void>((resolve) => {
    release = () => {
      fake.gate = null;
      resolve();
    };
  });
  const listeners = new Set<(event: WhiteboardCollaborationEvent) => void>();
  const collab: WhiteboardCollaborationOptions = {
    canDraw: false,
    submitUpdate: async (input) => ({ operationId: "operation", sceneId: input.sceneId, revision: "2" }),
    sendCursor: () => undefined,
    requestSnapshot: async () => undefined,
    clear: async () => ({ operationId: "clear", sceneId: "scene", revision: "2" }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Suspense fallback={null}>
          <WhiteboardCanvas collab={collab} />
        </Suspense>,
      ),
    );
    await settle();
    // The premise: React built an editor that it has not committed.
    expect(fake.instances.length).toBeGreaterThan(0);
    expect(fake.instances.some((instance) => instance.mounted)).toBe(false);

    await act(async () => release());
    await settle();
    const committed = fake.instances.filter((instance) => instance.mounted);
    expect(committed).toHaveLength(1);
    expect(fake.instances.length).toBeGreaterThan(1);
    expect(listeners.size).toBe(1);

    act(() => {
      for (const listener of listeners) listener({ type: "snapshot", sceneId: "scene", revision: "1", elements: [] });
    });
    const [kept] = committed;
    expect(kept?.api.updateScene).toHaveBeenCalledWith(expect.objectContaining({ elements: [] }));
    for (const discarded of fake.instances.filter((instance) => !instance.mounted)) expect(discarded.api.updateScene).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
