import { useEffect, useState } from "react";
import { parseTranscriptLanguage, transcriptLanguageValue, whisperLanguageCodes, type TranscriptLanguage } from "@chalk/transcript-language";
import { errorMessage } from "../../lib/dashboard/client";
import { useToast } from "./kit";

const names = new Intl.DisplayNames(["en"], { type: "language" });
const priority = ["en", "ur", "ar"] as const;
const languages = [...priority, ...whisperLanguageCodes.filter((code) => !priority.some((value) => value === code)).sort((a, b) => (names.of(a) ?? a).localeCompare(names.of(b) ?? b))];
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
          toast("Transcript language saved");
        } catch (cause) {
          setError(errorMessage(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field" style={{ maxWidth: 520 }}>
        <label className="lbl" htmlFor={inherit ? "space-transcript-language" : "tenant-transcript-language"}>
          Transcript language
        </label>
        <select
          className="inp"
          style={{ maxWidth: 320 }}
          id={inherit ? "space-transcript-language" : "tenant-transcript-language"}
          value={draft ?? "inherit"}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value === "inherit" ? null : transcriptLanguageValue(parseTranscriptLanguage(event.target.value)))}
          aria-describedby={inherit ? "space-transcript-language-help" : "tenant-transcript-language-help"}
        >
          {inherit ? <option value="inherit">Use account default</option> : null}
          <option value="auto">Auto-detect for mixed languages</option>
          {languages.map((code) => (
            <option key={code} value={code}>
              {names.of(code) ?? code}
            </option>
          ))}
        </select>
        <p className="help" id={inherit ? "space-transcript-language-help" : "tenant-transcript-language-help"}>
          {inherit ? "Applies to new transcripts for this call." : "The default for new transcripts, unless a call has its own setting."}
        </p>
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn pri" style={{ marginTop: 16 }} disabled={busy || draft === value}>
        {busy ? "Saving…" : "Save transcript language"}
      </button>
    </form>
  );
}
