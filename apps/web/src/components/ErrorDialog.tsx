import React, { useEffect, useState } from "react";
import { cn } from "@q9labs/chalk-ui/utils";
import { AlertCircleIcon, CheckIcon, CopyIcon, XIcon } from "lucide-react";

export interface ErrorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  message: string;
  traceId?: string;
  className?: string;
}

export const ErrorDialog: React.FC<ErrorDialogProps> = ({ isOpen, onClose, message, traceId, className }) => {
  const [copied, setCopied] = useState(false);

  const handleCopyTrace = () => {
    if (!traceId) return;
    void navigator.clipboard.writeText(traceId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className={cn("fixed inset-0 z-[60] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm", className)} role="alertdialog" aria-modal="true" aria-labelledby="error-title" aria-describedby="error-desc">
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-xl border border-destructive/20 bg-card shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <AlertCircleIcon size={20} className="text-destructive" />
            <span id="error-title" className="font-semibold text-card-foreground">
              An error occurred
            </span>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted" aria-label="Close dialog">
            <XIcon size={18} />
          </button>
        </div>

        <div className="space-y-4 px-6 py-6">
          <p id="error-desc" className="text-sm leading-relaxed text-card-foreground">
            {message}
          </p>

          {traceId && (
            <div className="rounded-lg border border-border bg-muted/50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Trace ID</span>
                <button onClick={handleCopyTrace} className={cn("flex items-center gap-1 text-[10px] font-medium transition-colors", copied ? "text-green-500" : "text-primary hover:underline")}>
                  {copied ? (
                    <>
                      <CheckIcon size={10} /> Copied
                    </>
                  ) : (
                    <>
                      <CopyIcon size={10} /> Copy ID
                    </>
                  )}
                </button>
              </div>
              <code className="select-all break-all font-mono text-[11px] text-muted-foreground">{traceId}</code>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border bg-muted/30 px-6 py-4">
          <button onClick={onClose} className="rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-all hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
