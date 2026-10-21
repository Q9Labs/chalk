import type { History } from "@excalidraw/excalidraw/history";
import type { AppClassProperties, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type EngineHistoryState = { readonly canUndo: boolean; readonly canRedo: boolean };

/** 0.18.1 exposes clear, but not the history reader/emitter, on its imperative API. */
export function observeEngineHistory(api: ExcalidrawImperativeAPI, canvas: HTMLElement, onChange: (state: EngineHistoryState) => void): () => void {
  let connected = false;
  let dispose = () => {};
  // Headless hosts do not offer Stats. Its action callback gives this version's native App.
  api.registerAction({
    name: "stats",
    label: "Stats",
    trackEvent: false,
    perform: () => false,
    keyTest: (_event, _state, _elements, app) => {
      if (connected) return false;
      connected = true;
      // Pinned-engine boundary: AppClassProperties omits this private, engine-owned field.
      const history = (app as AppClassProperties & { readonly history: History }).history;
      const read = () => ({ isUndoStackEmpty: history.isUndoStackEmpty, isRedoStackEmpty: history.isRedoStackEmpty });
      const originalClear = history.clear;
      const clear = () => {
        originalClear.call(history);
        // This engine version's clear omits the notification emitted by record/undo/redo.
        history.onHistoryChangedEmitter.trigger(read());
      };
      history.clear = clear;
      const update = () => {
        const state = read();
        onChange({ canUndo: !state.isUndoStackEmpty, canRedo: !state.isRedoStackEmpty });
      };
      const off = history.onHistoryChangedEmitter.on(update);
      update();
      dispose = () => {
        off();
        history.clear = originalClear;
      };
      return false;
    },
  });
  // A harmless modifier key runs keyTest without performing an engine action or editing the scene.
  canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
  return () => {
    connected = true;
    dispose();
  };
}
