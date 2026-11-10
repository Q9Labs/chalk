import { lazy, Suspense, useCallback, useState, type ReactNode, type RefObject } from "react";
import type { WhiteboardEngineHandle } from "../WhiteboardCanvas";
import type { BoardToast } from "./board-toasts";

const BoardClearDialog = lazy(() => import("./BoardClearDialog"));

/**
 * Clearing the board asks first, in the call's own dialog (a sheet on a phone). The Undo toast that follows stays,
 * so a clear that was meant can still be taken back.
 */
export function useClearBoard({
  engine,
  canDraw,
  toast,
  people,
  sheet,
  container,
}: {
  readonly engine: Pick<WhiteboardEngineHandle, "clearWithUndo"> | null;
  readonly canDraw: boolean;
  readonly toast: (toast: BoardToast) => void;
  readonly people: number;
  readonly sheet: boolean;
  readonly container: RefObject<HTMLElement | null>;
}): { readonly ask: () => void; readonly dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const clear = useCallback(async () => {
    setOpen(false);
    if (!engine) return;
    try {
      const restore = await engine.clearWithUndo();
      toast({ message: "Board cleared", ...(canDraw ? { action: { label: "Undo", onClick: () => void restore() } } : {}) });
    } catch {
      toast({ type: "error", message: "Could not clear the board. Try again." });
    }
  }, [canDraw, engine, toast]);
  const ask = useCallback(() => {
    setAsked(true);
    setOpen(true);
  }, []);
  const dialog = asked ? (
    <Suspense fallback={null}>
      <BoardClearDialog open={open} onOpenChange={setOpen} onConfirm={() => void clear()} people={people} canUndo={canDraw} sheet={sheet} container={container} />
    </Suspense>
  ) : null;
  return { ask, dialog };
}
