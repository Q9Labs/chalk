import React, { useEffect, useState } from "react";
import { cn } from "@q9labs/chalk-ui";
import { AlertCircleIcon, CopyIcon, CheckIcon, XIcon, ChevronRightIcon } from "lucide-react";

export interface ErrorDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Close handler */
  onClose: () => void;
  /** User-friendly error message */
  message: string;
  /** Backend trace ID for support */
  traceId?: string;
  /** Additional class names */
  className?: string;
}

/**
 * Global error dialog for displaying system or API errors with debug info
 */
export const ErrorDialog: React.FC<ErrorDialogProps> = ({ isOpen, onClose, message, traceId, className }) => {
  const [copied, setCopied] = useState(false);

  const handleCopyTrace = () => {
    if (!traceId) return;
    navigator.clipboard.writeText(traceId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className={cn("fixed inset-0 z-[60] flex items-center justify-center p-4 backdrop-blur-sm bg-background/80", className)} role="alertdialog" aria-modal="true" aria-labelledby="error-title" aria-describedby="error-desc">
      <div className="w-full max-w-md overflow-hidden rounded-xl shadow-2xl bg-card border border-destructive/20 flex flex-col animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <AlertCircleIcon size={20} className="text-destructive" />
            <span id="error-title" className="font-semibold text-card-foreground">
              An error occurred
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-muted text-muted-foreground transition-colors" aria-label="Close dialog">
            <XIcon size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-6 space-y-4">
          <p id="error-desc" className="text-sm text-card-foreground leading-relaxed">
            {message}
          </p>

          {traceId && (
            <div className="mt-6 p-3 rounded-lg bg-muted/50 border border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Trace ID</span>
                <button onClick={handleCopyTrace} className={cn("text-[10px] font-medium flex items-center gap-1 transition-colors", copied ? "text-green-500" : "text-primary hover:underline")}>
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
              <code className="text-[11px] font-mono text-muted-foreground break-all select-all">{traceId}</code>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border bg-muted/30 flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-6 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-all">
            Close
          </button>
        </div>

        {/* Support hint */}
        <div className="px-6 pb-4 flex items-center justify-center">
          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
            Include the Trace ID when contacting support <ChevronRightIcon size={10} />
          </p>
        </div>
      </div>
    </div>
  );
};
