import { useState } from "react";

import { act, errorMessage } from "../../lib/dashboard/client";
import { Icon } from "../site/Icon";
import type { Ids } from "./session-reads";
import { Dialog } from "./Dialog";
import { useToast } from "./kit";

/** Deletes only the transcript on screen. An older attempt's transcript then takes its place, so nothing goes unseen. */
export function DeleteTranscript({ ids, transcriptId, onClose, onDeleted }: { readonly ids: Ids; readonly transcriptId: string; readonly onClose: () => void; readonly onDeleted: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await act("past-session", { action: "delete-transcript", ...ids, transcriptId });
      toast("Transcript deleted.", { icon: "check" });
      onDeleted();
    } catch (error) {
      toast(errorMessage(error), { icon: "alert" });
      setBusy(false);
    }
  }
  return (
    <Dialog
      alert
      icon="trash"
      title="Delete this transcript?"
      description="The transcript is deleted for good. The recording and the session stay."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn out lg" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn dz lg" aria-busy={busy || undefined} disabled={busy} onClick={() => void remove()}>
            {busy ? <span className="spin" aria-hidden="true" /> : <Icon name="trash" size={16} />}
            Delete transcript
          </button>
        </>
      }
    >
      <div className="warnbox">
        <Icon name="alert" size={16} />
        <span>You can’t undo this.</span>
      </div>
    </Dialog>
  );
}
