import { useEffect, useRef, useState } from "react";

export function NewSpaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className="space-dialog" onClose={onClose} onCancel={onClose}>
      <form method="dialog" onSubmit={onClose}>
        <div className="space-dialog-accent" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <button className="dialog-close" value="cancel" aria-label="Close dialog">
          ×
        </button>
        <p className="eyebrow">A durable place to gather</p>
        <h2>Create a Space</h2>
        <p className="dialog-intro">A Space holds your team’s recurring Episodes and shared context.</p>

        <label htmlFor="space-name">Space name</label>
        <input id="space-name" name="space-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Product studio" autoFocus />

        <label htmlFor="space-description">
          What happens here? <span>Optional</span>
        </label>
        <textarea id="space-description" name="space-description" placeholder="Critiques, focused work, and product decisions." rows={3} />

        <fieldset>
          <legend>Who can find this Space?</legend>
          <label className="visibility-option">
            <input type="radio" name="visibility" value="tenant" defaultChecked />
            <span>
              <strong>Everyone in the Tenant</strong>
              <small>People with Tenant access can find and join it.</small>
            </span>
          </label>
          <label className="visibility-option">
            <input type="radio" name="visibility" value="invited" />
            <span>
              <strong>Invited people</strong>
              <small>Only people you invite can see it.</small>
            </span>
          </label>
        </fieldset>

        <div className="dialog-actions">
          <button value="cancel" className="dashboard-button secondary">
            Cancel
          </button>
          <button value="create" className="dashboard-button primary" disabled={!name.trim()}>
            Create Space
          </button>
        </div>
        <p className="fixture-note">Preview only—creation will connect after the Tenant contract lands.</p>
      </form>
    </dialog>
  );
}
