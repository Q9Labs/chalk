import { useRef, useState } from "react";
import { createSpace, type Space } from "../../lib/dashboard-api";
import { runSpaceMutation, slugifySpaceName, SpaceDialogActions, SpaceDialogError, SpaceDialogFrame, SpaceDialogHeading, useModalDialog } from "./SpaceDialogPrimitives";

type NewSpaceDialogProps = {
  open: boolean;
  onClose: () => void;
  tenantID?: string;
  onCreated?: (space: Space) => void;
};

export function NewSpaceDialog({ open, onClose, tenantID, onCreated }: NewSpaceDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [admission, setAdmission] = useState<"open" | "knock">("open");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useModalDialog(dialogRef, open);

  function changeName(value: string) {
    setName(value);
    if (!slug || slug === slugifySpaceName(name)) setSlug(slugifySpaceName(value));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantID || !name.trim() || !slug.trim() || saving) return;
    const trimmedDescription = description.trim();
    await runSpaceMutation({
      request: () =>
        createSpace({
          tenantID,
          name: name.trim(),
          slug: slug.trim(),
          media_plane: "cf_rtk",
          metadata: trimmedDescription ? { description: trimmedDescription } : undefined,
          admission_policy: { mode: admission },
        }),
      onSuccess: (space) => {
        onCreated?.(space);
        setName("");
        setSlug("");
        setDescription("");
        setAdmission("open");
        onClose();
      },
      setBusy: setSaving,
      setError,
      failureMessage: "We could not create this Space. Try again.",
    });
  }

  return (
    <SpaceDialogFrame dialogRef={dialogRef} onClose={onClose} onSubmit={(event) => void handleSubmit(event)}>
      <SpaceDialogHeading title="Create a Space" description="A Space holds your team’s recurring Episodes and shared context." />

      <label htmlFor="space-name">Space name</label>
      <input id="space-name" name="space-name" value={name} onChange={(event) => changeName(event.target.value)} placeholder="e.g. Product studio" autoFocus />

      <label htmlFor="space-slug">Join slug</label>
      <input id="space-slug" name="space-slug" value={slug} onChange={(event) => setSlug(slugifySpaceName(event.target.value))} placeholder="product-studio" autoComplete="off" />

      <label htmlFor="space-description">
        What happens here? <span>Optional</span>
      </label>
      <textarea id="space-description" name="space-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Critiques, focused work, and product decisions." rows={3} />

      <fieldset>
        <legend>How can people enter this Space?</legend>
        <label className="visibility-option">
          <input type="radio" name="visibility" value="tenant" checked={admission === "open"} onChange={() => setAdmission("open")} />
          <span>
            <strong>Everyone in the Tenant</strong>
            <small>People with Tenant access can find and join it.</small>
          </span>
        </label>
        <label className="visibility-option">
          <input type="radio" name="visibility" value="knock" checked={admission === "knock"} onChange={() => setAdmission("knock")} />
          <span>
            <strong>Ask to join</strong>
            <small>People with Tenant access can request access before an Episode starts.</small>
          </span>
        </label>
      </fieldset>

      <SpaceDialogActions onClose={onClose} disabled={!tenantID || !name.trim() || !slug.trim() || saving} busyLabel={saving ? "Creating…" : undefined} submitLabel="Create Space" />
      <SpaceDialogError message={error} />
      {!tenantID ? <p className="fixture-note">Choose a Tenant before creating a Space.</p> : null}
    </SpaceDialogFrame>
  );
}
