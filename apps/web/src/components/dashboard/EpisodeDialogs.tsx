import { useEffect, useRef, type FormEvent } from "react";
import type { DashboardEpisode, DashboardSpace } from "../../lib/dashboard-api";

export function StartEpisodeDialog({
  open,
  spaces,
  selectedSpaceID,
  busy,
  error,
  onClose,
  onSpaceChange,
  onSubmit,
}: {
  open: boolean;
  spaces: DashboardSpace[];
  selectedSpaceID: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSpaceChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useDialogVisibility(dialogRef, open, onClose);
  return (
    <dialog ref={dialogRef} className="episode-dialog" onClose={onClose} onCancel={onClose}>
      <form onSubmit={onSubmit}>
        <button className="dialog-close" type="button" aria-label="Close dialog" onClick={onClose}>
          ×
        </button>
        <p className="eyebrow">A bounded run of activity</p>
        <h2>Start and join</h2>
        <p className="dialog-intro">This starts the selected Space now and then opens it. You can also open a Space directly and let the Episode begin automatically.</p>
        <label htmlFor="episode-space">Space</label>
        <select id="episode-space" value={selectedSpaceID} onChange={(event) => onSpaceChange(event.target.value)} disabled={busy} required>
          <option value="" disabled>
            Select a Space
          </option>
          {spaces.map((space) => (
            <option value={space.id} key={space.id}>
              {space.name}
            </option>
          ))}
        </select>
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button className="dashboard-button secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="dashboard-button primary" type="submit" disabled={busy || !selectedSpaceID}>
            {busy ? "Starting…" : "Start and join"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function EndEpisodeDialog({ open, episode, busy, error, onClose, onConfirm }: { open: boolean; episode: DashboardEpisode | null; busy: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useDialogVisibility(dialogRef, open, onClose);
  return (
    <dialog ref={dialogRef} className="episode-dialog episode-end-dialog" onClose={onClose} onCancel={onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <button className="dialog-close" type="button" aria-label="Close dialog" onClick={onClose}>
          ×
        </button>
        <p className="eyebrow">This cannot be undone</p>
        <h2>End this Episode?</h2>
        <p className="dialog-intro">Ending freezes the Episode identity, attendance, and configuration snapshot forever. The Space remains available for a future Episode.</p>
        {episode?.status === "ending" ? <p className="episode-warning-note">This Episode is already ending. We’ll safely retry the same operation if needed.</p> : null}
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button className="dashboard-button secondary" type="button" onClick={onClose} disabled={busy}>
            Keep it live
          </button>
          <button className="dashboard-button primary episode-danger-button" type="submit" disabled={busy}>
            {busy ? "Ending…" : "End Episode"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function useDialogVisibility(ref: { current: HTMLDialogElement | null }, open: boolean, onClose: () => void) {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open, ref]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || typeof dialog.showModal === "function") return;
    const onCancel = () => onClose();
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onClose, ref]);
}
