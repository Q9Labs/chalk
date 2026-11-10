import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useSheetDrag } from "./useSheetDrag";
export interface ChalkSheetProps {
  /** `reactions` has no scrim, so what floats over the call stays bright. */
  readonly variant?: "default" | "details" | "panel" | "reactions" | "ready" | "stage";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly accessibleLabel?: string;
  readonly children: ReactNode;
}
/**
 * Base UI owns the focus trap, Escape, outside press and return to the opener.
 * A drag that starts on the grabber or the heading closes the sheet, past 30% of its height or on a flick.
 */
export function ChalkSheet({ open, onOpenChange, title, accessibleLabel, children, variant = "default" }: ChalkSheetProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const drag = useSheetDrag(popup, scrim, () => onOpenChange(false));
  const attach = useCallback((element: HTMLElement | null) => setContainer(element?.closest<HTMLElement>("[data-chalk]") ?? element), []);
  return (
    <span ref={attach} style={{ display: "contents" }}>
      <Dialog.Root
        open={open}
        onOpenChange={(next, details) => {
          // The reactions sheet has no scrim, so a tap on a call notice's button must reach the notice and leave the sheet open.
          if (variant === "reactions" && details.reason === "outside-press" && details.event.target instanceof Element && details.event.target.closest(".chalk-toasts")) {
            details.cancel();
            return;
          }
          onOpenChange(next);
        }}
        modal={variant !== "reactions"}
      >
        {container ? (
          <Dialog.Portal container={container}>
            {variant === "reactions" ? null : <Dialog.Backdrop ref={scrim} data-part="sheet-scrim" className="chalk-sheet-scrim" />}
            <Dialog.Popup
              ref={popup}
              {...(accessibleLabel ? { "aria-label": accessibleLabel, "aria-labelledby": undefined } : {})}
              initialFocus={variant === "ready" ? () => container.querySelector<HTMLElement>("[data-part=ready-title]") : undefined}
              finalFocus={variant === "ready" ? () => container.querySelector<HTMLElement>("[data-call-link-trigger]") : undefined}
              data-part={variant === "ready" ? "call-ready" : variant === "panel" ? "panel-card" : "sheet"}
              data-variant={variant}
              className={variant === "ready" ? "chalk-sheet data-[starting-style]:!translate-y-8 data-[ending-style]:!translate-y-8" : "chalk-sheet"}
              style={variant === "ready" ? { padding: "0 var(--space-5) var(--space-12)", borderTop: "1px solid var(--chalk-line)", transitionDuration: "200ms" } : undefined}
            >
              <div data-part="sheet-handle" data-sheet-drag className="chalk-sheet-handle" {...drag} />
              {variant !== "details" ? (
                <Dialog.Title className="sr-only">{title}</Dialog.Title>
              ) : (
                <div data-sheet-drag className="chalk-sheet-heading" {...drag}>
                  <Dialog.Title>{title}</Dialog.Title>
                  <Dialog.Close data-part="sheet-dismiss" className="chalk-dismiss" aria-label="Close">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m6 6 12 12M6 18 18 6" />
                    </svg>
                  </Dialog.Close>
                </div>
              )}
              {variant === "default" || variant === "details" || variant === "reactions" ? <div className="chalk-sheet-body">{children}</div> : children}
            </Dialog.Popup>
          </Dialog.Portal>
        ) : null}
      </Dialog.Root>
    </span>
  );
}
