import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useRef, type RefObject } from "react";
import { BoardIcon } from "./BoardIcon";

/** Whoever the board belongs to loses it when it is cleared, so the dialog says how many people that is. */
function clearConfirmBody(people: number, canUndo: boolean): string {
  const goes = people > 1 ? `Everything on it goes for the ${people} people here.` : "Everything on it goes.";
  return canUndo ? `${goes} You can undo right after.` : goes;
}

/** The call's own confirm dialog (a sheet on a phone). It loads on the first Clear board, so a board nobody clears never pays for it. */
export default function BoardClearDialog({
  open,
  onOpenChange,
  onConfirm,
  people,
  canUndo,
  sheet,
  container,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly people: number;
  readonly canUndo: boolean;
  readonly sheet: boolean;
  readonly container: RefObject<HTMLElement | null>;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal container={container}>
        <AlertDialog.Backdrop className="chalk-board-scrim" />
        <AlertDialog.Popup className="chalk-board-dialog" data-sheet={sheet || undefined} initialFocus={cancel}>
          <AlertDialog.Title className="chalk-board-dialog-title">Clear the board for everyone?</AlertDialog.Title>
          <AlertDialog.Description className="chalk-board-dialog-body">{clearConfirmBody(people, canUndo)}</AlertDialog.Description>
          <div className="chalk-board-dialog-actions">
            <AlertDialog.Close ref={cancel} type="button">
              Cancel
            </AlertDialog.Close>
            <button type="button" className="chalk-board-dialog-danger" onClick={onConfirm}>
              <BoardIcon name="trash" size={16} />
              Clear board
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
