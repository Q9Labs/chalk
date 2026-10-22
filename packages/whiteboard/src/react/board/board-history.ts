import { useEffect, useState, type MutableRefObject } from "react";
import { observeEngineHistory } from "../engine-history";
import type { WhiteboardEngineHandle } from "../WhiteboardCanvas";

/** Reads the engine's stacks; never counts host mutations. */
export function useEngineHistory(root: MutableRefObject<HTMLElement | null>, engine: WhiteboardEngineHandle | null) {
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  useEffect(() => {
    const canvas = root.current?.querySelector<HTMLElement>(".excalidraw");
    if (!engine || !canvas) return;
    return observeEngineHistory(engine.api, canvas, setHistory);
  }, [engine, root]);
  return history;
}
