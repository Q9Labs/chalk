import { useEffect, useState } from "react";
import { type TranscriptLanguage } from "@chalk/transcript-language";
import { errorMessage } from "../../lib/dashboard/client";
import { LanguagePicker } from "./LanguagePicker";
import { rememberLanguage } from "./transcript-languages";
import { useToast } from "./kit";

export function TranscriptLanguageSettings({ value, inherit = false, onSave }: { readonly value: TranscriptLanguage | null; readonly inherit?: boolean; readonly onSave: (value: TranscriptLanguage | null) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => setDraft(value), [value]);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || draft === value) return;
        setBusy(true);
        setError(null);
        try {
          await onSave(draft);
          if (draft && draft !== "auto") rememberLanguage(draft);
          toast("Transcript language saved");
        } catch (cause) {
          setError(errorMessage(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field" style={{ maxWidth: 520 }}>
        <span className="lbl" id={inherit ? "space-transcript-language-label" : "tenant-transcript-language-label"}>
          Transcript language
        </span>
        <LanguagePicker
          id={inherit ? "space-transcript-language" : "tenant-transcript-language"}
          labelledBy={inherit ? "space-transcript-language-label" : "tenant-transcript-language-label"}
          value={draft}
          allowDefault={inherit}
          loading={busy}
          loadingLabel="Saving…"
          onChange={setDraft}
          describedBy={inherit ? "space-transcript-language-help" : "tenant-transcript-language-help"}
        />
        <p className="help" id={inherit ? "space-transcript-language-help" : "tenant-transcript-language-help"}>
          {inherit ? "Applies to new transcripts for this call." : "The default for new transcripts, unless a call has its own setting."}
        </p>
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn pri" style={{ marginTop: "var(--space-4)" }} disabled={busy || draft === value}>
        {busy ? "Saving…" : "Save transcript language"}
      </button>
    </form>
  );
}
