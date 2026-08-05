import { useCallback, useRef, useState } from "react";
import { DashboardAPIError, archiveSpace, restoreSpace, type Space } from "../../lib/dashboard-api";
import { SpaceDialogActions, SpaceDialogError, SpaceDialogFrame, useModalDialog } from "./SpaceDialogPrimitives";

type SpaceLifecycleDialogProps = {
  open: boolean;
  tenantID?: string;
  space: Space | null;
  action: "archive" | "restore";
  onClose: () => void;
  onChanged?: (space: Space) => void;
};

export function SpaceLifecycleDialog({ open, tenantID, space, action, onClose, onChanged }: SpaceLifecycleDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetError = useCallback(() => setError(null), []);
  useModalDialog(dialogRef, open, resetError);

  async function confirmLifecycle() {
    if (!tenantID || !space || busy) return;
    setBusy(true);
    setError(null);
    try {
      const changed = action === "archive" ? await archiveSpace({ tenantID, spaceID: space.id }) : await restoreSpace({ tenantID, spaceID: space.id });
      onChanged?.(changed);
      onClose();
    } catch (cause: unknown) {
      setError(cause instanceof DashboardAPIError ? cause.message : `We could not ${action} this Space. Try again.`);
    } finally {
      setBusy(false);
    }
  }

  const archive = action === "archive";
  return (
    <SpaceDialogFrame
      dialogRef={dialogRef}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void confirmLifecycle();
      }}
    >
      <p className="eyebrow">{archive ? "Pause new activity" : "Make it available again"}</p>
      <h2>{archive ? "Archive this Space?" : "Restore this Space?"}</h2>
      <p className="dialog-intro">{archive ? "The Space stays readable and all Episode history remains intact. New Episodes and joins stop until you restore it." : "This Space becomes joinable again. Its existing Episodes and history are unchanged."}</p>
      {space ? (
        <p className="fixture-note">
          <strong>{space.name}</strong> · <code>{space.slug}</code>
        </p>
      ) : null}
      <SpaceDialogActions onClose={onClose} disabled={!tenantID || !space || busy} busyLabel={busy ? (archive ? "Archiving…" : "Restoring…") : undefined} submitLabel={archive ? "Archive Space" : "Restore Space"} />
      <SpaceDialogError message={error} />
    </SpaceDialogFrame>
  );
}
