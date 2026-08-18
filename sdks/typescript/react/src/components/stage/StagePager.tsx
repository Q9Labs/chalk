import React from "react";

import { cn } from "../../utils/cn";
import { ArrowLeft01Icon, ArrowRight01Icon } from "../../utils/icons";

export interface StagePagerProps {
  readonly page: number;
  readonly pageCount: number;
  readonly onPageChange: (page: number) => void;
  /** Vertical centre of the paged tiles, px from the top of the stage; the arrows sit on the stage edges at this height. */
  readonly arrowsCenterY: number | null;
  /** Height of the band under the tiles that holds the page dots. */
  readonly dotsHeight: number;
}

const ARROW_CLASS =
  "pointer-events-auto grid h-9 w-9 place-items-center rounded-full bg-[rgba(12,14,18,0.55)] text-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] ring-1 ring-white/10 backdrop-blur-md transition hover:bg-[rgba(12,14,18,0.75)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:pointer-events-none disabled:opacity-0";

/** Previous / next arrows on the stage edges beside the paged tiles, page dots underneath. Announces the current page. */
export function StagePager({ page, pageCount, onPageChange, arrowsCenterY, dotsHeight }: StagePagerProps): React.JSX.Element {
  const arrowStyle: React.CSSProperties | undefined = arrowsCenterY === null ? undefined : { top: arrowsCenterY + 4, transform: "translateY(-50%)" };
  return (
    <nav className="pointer-events-none absolute inset-0 z-30" aria-label="Stage pages">
      <button type="button" className={cn(ARROW_CLASS, "absolute left-3", arrowsCenterY === null && "top-1/2 -translate-y-1/2")} style={arrowStyle} onClick={() => onPageChange(Math.max(0, page - 1))} disabled={page === 0} aria-label="Previous page">
        <ArrowLeft01Icon size={16} />
      </button>
      <button type="button" className={cn(ARROW_CLASS, "absolute right-3", arrowsCenterY === null && "top-1/2 -translate-y-1/2")} style={arrowStyle} onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1} aria-label="Next page">
        <ArrowRight01Icon size={16} />
      </button>
      <div className="pointer-events-auto absolute inset-x-0 bottom-0 flex items-center justify-center gap-2" style={{ height: dotsHeight }} role="group" aria-label={`Page ${page + 1} of ${pageCount}`}>
        {Array.from({ length: pageCount }, (_, index) => (
          <button key={index} type="button" className="grid h-4 w-4 place-items-center rounded-full" onClick={() => onPageChange(index)} aria-label={`Go to page ${index + 1}`} aria-current={index === page ? "page" : undefined}>
            <span className={cn("block size-1.5 rounded-full transition-colors", index === page ? "bg-[var(--chalk-app-text-muted)]" : "bg-[var(--chalk-app-line-strong)] opacity-70")} />
          </button>
        ))}
      </div>
      <span className="sr-only" aria-live="polite">
        Page {page + 1} of {pageCount}
      </span>
    </nav>
  );
}

StagePager.displayName = "StagePager";
