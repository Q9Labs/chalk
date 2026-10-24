// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import type { WhiteboardCollaborationEvent } from "../collab/engine";
import { WhiteboardCanvas, type WhiteboardCollaborationOptions } from "./index";

type FakeApi = ReturnType<typeof createApi>;

const fake = vi.hoisted(() => ({ editors: [] as { readonly api: FakeApi; mounted: boolean }[] }));

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
// editor, it hands over its API from its class constructor, while React is still rendering.
vi.mock("@excalidraw/excalidraw", async () => {
  const { Component } = await import("react");
  class Excalidraw extends Component<{ readonly excalidrawAPI: (api: FakeApi) => void }> {
    readonly editor = { api: createApi(), mounted: false };
    constructor(props: { readonly excalidrawAPI: (api: FakeApi) => void }) {
      super(props);
      fake.editors.push(this.editor);
      props.excalidrawAPI(this.editor.api);
    }
    override componentDidMount() {
      this.editor.mounted = true;
    }
    override render() {
      return null;
    }
  }
  return {
    CaptureUpdateAction: { NEVER: "NEVER", IMMEDIATELY: "IMMEDIATELY" },
    MIME_TYPES: { binary: "application/octet-stream" },
    isInvisiblySmallElement: () => false,
    newElementWith: <T extends object>(element: T, update: Partial<T>) => ({ ...element, ...update }),
    reconcileElements: (_local: readonly object[], remote: readonly object[]) => [...remote],
    restoreElements: (elements: readonly object[]) => [...elements],
    Excalidraw,
  };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  fake.editors.length = 0;
});

it("collaborates on the editor React keeps when Strict Mode builds it twice", async () => {
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
        <StrictMode>
          <WhiteboardCanvas collab={collab} />
        </StrictMode>,
      ),
    );
    await vi.waitFor(() => expect(listeners.size).toBe(1));

    // Strict Mode built a second editor and threw one away. Only the kept one may receive the board.
    expect(fake.editors).toHaveLength(2);
    const kept = fake.editors.filter((editor) => editor.mounted);
    expect(kept).toHaveLength(1);
    act(() => {
      for (const listener of listeners) listener({ type: "snapshot", sceneId: "scene", revision: "1", elements: [] });
    });
    for (const editor of fake.editors) {
      if (editor.mounted) expect(editor.api.updateScene).toHaveBeenCalledWith(expect.objectContaining({ elements: [] }));
      else expect(editor.api.updateScene).not.toHaveBeenCalled();
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
