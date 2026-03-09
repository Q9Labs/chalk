import React, { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import { cn } from "../../utils/cn";
import { Clock01Icon, SparklesIcon, TickDouble01Icon } from "../../utils/icons";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";
import type { WhatsNewData } from "../../hooks/ui/useWhatsNew";
import { ReleaseBadge } from "../atomic/ReleaseBadge";

export interface WhatsNewDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Close handler */
  onClose: () => void;
  /** All releases to display */
  releases: WhatsNewData[];
  /** Current position (0-based) */
  currentIndex: number;
  /** Go to next release */
  onNext: () => void;
  /** Go to previous release */
  onPrev: () => void;
  /** Skip all - mark all as seen and close */
  onSkipAll: () => void;
  /** Later - close without marking */
  onLater: () => void;
  /** Additional class names */
  className?: string;
}

/**
 * Dialog showing recent release notes with multi-release navigation
 *
 * @example
 * ```tsx
 * const {
 *   isOpen, releases, currentIndex,
 *   next, prev, markAllAsSeen, later, close
 * } = useWhatsNew();
 *
 * <WhatsNewDialog
 *   isOpen={isOpen}
 *   releases={releases}
 *   currentIndex={currentIndex}
 *   onNext={next}
 *   onPrev={prev}
 *   onSkipAll={markAllAsSeen}
 *   onLater={later}
 *   onClose={close}
 * />
 * ```
 */
export const WhatsNewDialog = React.memo<WhatsNewDialogProps>(({ isOpen, onClose, releases, currentIndex, onNext, onPrev, onSkipAll, onLater, className }) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const modalRef = useRef<HTMLDivElement>(null);

  const total = releases.length;
  const data = releases[currentIndex];
  const hasNext = currentIndex < total - 1;
  const hasPrev = currentIndex > 0;
  const isLast = currentIndex === total - 1;

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case "Escape":
          onClose();
          break;
        case "ArrowRight":
          if (hasNext) onNext();
          break;
        case "ArrowLeft":
          if (hasPrev) onPrev();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, hasNext, hasPrev, onNext, onPrev, onClose]);

  // Focus trap
  useEffect(() => {
    if (isOpen && modalRef.current) {
      modalRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen || !data) return null;

  const publishedDate = new Date(data.published_at);
  const formattedDate = publishedDate.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm", "bg-background/80", className)} role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
      <div ref={modalRef} tabIndex={-1} className={cn("w-full max-w-3xl overflow-hidden rounded-xl shadow-lg", "bg-card", "border border-border", "flex flex-col max-h-[85vh]", !prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-200")}>
        {/* Main content: Image left (40%), Content right (60%) */}
        <div className="flex flex-1 min-h-0">
          {/* Image section - 40% width, full height */}
          {data.image_url && (
            <div className="hidden md:block w-2/5 shrink-0 bg-muted">
              <img src={data.image_url} alt={`What's new in version ${data.version}`} className="w-full h-full object-cover" />
            </div>
          )}

          {/* Content section - 60% (or 100% if no image) */}
          <div className={cn("flex flex-col flex-1 min-h-0", data.image_url ? "md:w-3/5" : "w-full")}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <SparklesIcon size={20} className="text-primary" />
                <span className="font-semibold text-card-foreground">What's New</span>
              </div>
              <span className="text-sm text-muted-foreground">
                {currentIndex + 1} of {total}
              </span>
            </div>

            {/* Release info */}
            <div className="px-6 pt-4 shrink-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 id="whats-new-title" className="text-lg font-semibold text-card-foreground">
                  v{data.version}
                  {data.title && ` - ${data.title}`}
                </h2>
                <ReleaseBadge type={data.release_type} />
              </div>
              <p className="text-sm text-muted-foreground mt-1">{formattedDate}</p>
            </div>

            {/* Markdown content - scrollable */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <div
                className={cn(
                  "prose prose-sm dark:prose-invert max-w-none",
                  "prose-headings:text-card-foreground prose-headings:font-semibold",
                  "prose-h2:text-base prose-h2:mt-4 prose-h2:mb-2",
                  "prose-h3:text-sm prose-h3:mt-3 prose-h3:mb-1",
                  "prose-p:text-muted-foreground prose-p:leading-relaxed",
                  "prose-li:text-muted-foreground",
                  "prose-strong:text-card-foreground prose-strong:font-medium",
                  "prose-a:text-primary hover:prose-a:underline",
                )}
              >
                <Markdown>{data.content}</Markdown>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-border shrink-0">
              <div className="flex items-center justify-between gap-4">
                {/* Pagination dots */}
                <div className="flex items-center gap-1.5">
                  {releases.map((_, i) => (
                    <span key={i} className={cn("w-2 h-2 rounded-full transition-colors", i === currentIndex ? "bg-primary" : "bg-muted-foreground/30")} aria-hidden="true" />
                  ))}
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2">
                  <button onClick={onLater} className={cn("px-4 py-2 rounded-lg text-sm font-medium transition-colors", "text-muted-foreground hover:text-foreground hover:bg-muted", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "inline-flex items-center gap-1.5")}>
                    <Clock01Icon size={16} />
                    Later
                  </button>
                  <button onClick={onSkipAll} className={cn("px-4 py-2 rounded-lg text-sm font-medium transition-colors", "text-muted-foreground hover:text-foreground hover:bg-muted", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", "inline-flex items-center gap-1.5")}>
                    <TickDouble01Icon size={16} />
                    Skip All
                  </button>
                  <button onClick={isLast ? onSkipAll : onNext} className={cn("px-4 py-2 rounded-lg text-sm font-medium transition-colors", "bg-primary text-primary-foreground", "hover:opacity-90", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>
                    {isLast ? "Got It" : "Next"}
                  </button>
                </div>
              </div>

              {/* Keyboard hints */}
              <p className="text-xs text-muted-foreground text-center mt-3">
                {total > 1 ? (
                  <>
                    <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs">&larr;</kbd> / <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs">&rarr;</kbd> to navigate,{" "}
                  </>
                ) : null}
                <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs">Esc</kbd> to close
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

WhatsNewDialog.displayName = "WhatsNewDialog";
