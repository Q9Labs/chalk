import { useState } from "react";

export function AnnotationTextForm({ onClose, onApply }: { readonly onClose: () => void; readonly onApply: (text: string, note: boolean) => void }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState(false);
  const tooLong = new TextEncoder().encode(text.trim()).length > 512;
  return (
    <form
      className="absolute inset-x-3 top-3 z-30 mx-auto grid max-w-sm gap-2 rounded-lg bg-[var(--chalk-overlay-strong)] p-3 text-[var(--chalk-on-overlay)]"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim() && !tooLong) onApply(text.trim(), note);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="grid gap-1">
        Annotation text
        <input autoFocus className="rounded bg-[var(--chalk-tile)] px-2 py-1 text-[var(--chalk-text)]" value={text} maxLength={512} onChange={(event) => setText(event.target.value)} />
      </label>
      {tooLong ? <span role="status">This text is too long for a mark.</span> : null}
      <label className="flex gap-2">
        <input type="checkbox" checked={note} onChange={(event) => setNote(event.target.checked)} /> Note background
      </label>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={!text.trim() || tooLong}>
          Add text
        </button>
      </div>
    </form>
  );
}
