import { useEffect, useRef, useState } from "react";
import { updateSpace, type Space } from "../../lib/dashboard-api";
import { runSpaceMutation, slugifySpaceName, SpaceDialogActions, SpaceDialogError, SpaceDialogFrame, SpaceDialogHeading, useModalDialog } from "./SpaceDialogPrimitives";

type EditSpaceDialogProps = {
  open: boolean;
  tenantID?: string;
  space: Space | null;
  onClose: () => void;
  onSaved?: (space: Space) => void;
};

export function EditSpaceDialog({ open, tenantID, space, onClose, onSaved }: EditSpaceDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [admission, setAdmission] = useState<"open" | "knock" | "members_only">("open");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useModalDialog(dialogRef, open);

  useEffect(() => {
    if (!space) return;
    setName(space.name);
    setSlug(space.slug);
    setAdmission(readAdmissionMode(space.admission_policy));
    setError(null);
  }, [space]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantID || !space || !name.trim() || !slug.trim() || saving) return;
    await runSpaceMutation({
      request: () => updateSpace({ tenantID, spaceID: space.id, name: name.trim(), slug: slug.trim(), admission_policy: { mode: admission } }),
      onSuccess: (updated) => {
        onSaved?.(updated);
        onClose();
      },
      setBusy: setSaving,
      setError,
      failureMessage: "We could not save this Space. Try again.",
    });
  }

  return (
    <SpaceDialogFrame dialogRef={dialogRef} onClose={onClose} onSubmit={(event) => void handleSubmit(event)}>
      <SpaceDialogHeading title="Edit Space" description="Changes apply to the next Episode. A live Episode keeps its immutable configuration snapshot." />

      <label htmlFor="edit-space-name">Space name</label>
      <input id="edit-space-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      <label htmlFor="edit-space-slug">Join slug</label>
      <input id="edit-space-slug" value={slug} onChange={(event) => setSlug(slugifySpaceName(event.target.value))} autoComplete="off" />

      <fieldset>
        <legend>Admission policy</legend>
        <label className="visibility-option">
          <input type="radio" name="edit-visibility" checked={admission === "open"} onChange={() => setAdmission("open")} />
          <span>
            <strong>Open</strong>
            <small>Anyone with Tenant access can enter.</small>
          </span>
        </label>
        <label className="visibility-option">
          <input type="radio" name="edit-visibility" checked={admission === "knock"} onChange={() => setAdmission("knock")} />
          <span>
            <strong>Ask to join</strong>
            <small>People request access before entering.</small>
          </span>
        </label>
      </fieldset>

      {admission === "members_only" ? (
        <p className="fixture-note" role="status">
          This Space uses a members-only policy, but Space membership enforcement is not available yet. Choose Open or Ask to join before saving.
        </p>
      ) : null}

      <SpaceDialogActions onClose={onClose} disabled={!tenantID || !space || !name.trim() || !slug.trim() || admission === "members_only" || saving} busyLabel={saving ? "Saving…" : undefined} submitLabel="Save changes" />
      <SpaceDialogError message={error} />
    </SpaceDialogFrame>
  );
}

function readAdmissionMode(value: unknown): "open" | "knock" | "members_only" {
  if (value && typeof value === "object" && "mode" in value) {
    const mode = (value as { mode?: unknown }).mode;
    if (mode === "knock" || mode === "members_only") return mode;
  }
  return "open";
}
