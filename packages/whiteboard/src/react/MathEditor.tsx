import { useState, type ReactNode } from "react";
import type { WhiteboardCanvasClassNames } from "./WhiteboardCanvas.js";

export interface MathEditorIcons {
  close?: ReactNode;
  submit?: ReactNode;
  submitting?: ReactNode;
}

interface MathEditorProps {
  initialLatex: string;
  isEditing: boolean;
  classNames: WhiteboardCanvasClassNames;
  icons: MathEditorIcons;
  onClose: () => void;
  onSubmit: (latex: string) => Promise<void>;
}

// Conditional branches directly represent the editor's submission and error states.
// fallow-ignore-next-line complexity
export function MathEditor({ initialLatex, isEditing, classNames, icons, onClose, onSubmit }: MathEditorProps): React.JSX.Element {
  const [latex, setLatex] = useState(initialLatex);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = latex.trim().length > 0 && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(latex.trim());
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to render equation");
      setIsSubmitting(false);
    }
  };

  return (
    <div className={classNames.mathOverlay} style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className={classNames.mathDialog} style={{ width: "100%", maxWidth: 576 }}>
        <div className={classNames.mathHeader} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className={classNames.mathTitle}>{isEditing ? "Edit equation" : "Math"}</div>
          <button type="button" onClick={onClose} className={classNames.mathCloseButton} aria-label="Close math editor">
            {icons.close ?? "x"}
          </button>
        </div>
        <div className={classNames.mathBody} style={{ display: "grid", gap: 12 }}>
          <textarea value={latex} onChange={(event) => setLatex(event.target.value)} className={classNames.mathTextarea} spellCheck={false} autoFocus aria-label="LaTeX equation" />
          {error && <div className={classNames.mathError}>{error}</div>}
          <div className={classNames.mathActions} style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onClose} className={classNames.mathCancelButton}>
              Cancel
            </button>
            <button type="button" onClick={handleSubmit} disabled={!canSubmit} className={classNames.mathSubmitButton}>
              {isSubmitting ? icons.submitting : icons.submit}
              Insert
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
