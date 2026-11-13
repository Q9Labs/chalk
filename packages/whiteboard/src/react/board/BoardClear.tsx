import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import type { WhiteboardEngineHandle } from "../WhiteboardCanvas";
import { BoardIcon } from "./BoardIcon";
import type { BoardToast } from "./board-toasts";

/** Whoever the board belongs to loses it when it is cleared, so the dialog says how many people that is. */
function clearConfirmBody(people: number, canUndo: boolean): string {
  const goes = people > 1 ? `Everything on it goes for the ${people} people here.` : "Everything on it goes.";
  return canUndo ? `${goes} You can undo right after.` : goes;
}

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
  const cancel = useRef<HTMLButtonElement>(null);
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
  const ask = useCallback(() => setOpen(true), []);
  const dialog = (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Portal container={container}>
        <AlertDialog.Backdrop className="chalk-board-scrim" />
        <AlertDialog.Popup className="chalk-board-dialog" data-sheet={sheet || undefined} initialFocus={cancel}>
          <AlertDialog.Title className="chalk-board-dialog-title">Clear the board for everyone?</AlertDialog.Title>
          <AlertDialog.Description className="chalk-board-dialog-body">{clearConfirmBody(people, canDraw)}</AlertDialog.Description>
          <div className="chalk-board-dialog-actions">
            <AlertDialog.Close ref={cancel} type="button">
              Cancel
            </AlertDialog.Close>
            <button type="button" className="chalk-board-dialog-danger" onClick={() => void clear()}>
              <BoardIcon name="trash" size={16} />
              Clear board
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
  return { ask, dialog };
}
