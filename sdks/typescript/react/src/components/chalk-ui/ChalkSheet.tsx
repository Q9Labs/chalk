import { Dialog } from "@base-ui/react/dialog";
import { useRef, type ReactNode } from "react";
export interface ChalkSheetProps {
  readonly variant?: "default" | "details" | "panel";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly accessibleLabel?: string;
  readonly children: ReactNode;
}
/** Base UI owns the focus trap, Escape, outside press and return to the opener. */
export function ChalkSheet({ open, onOpenChange, title, accessibleLabel, children, variant = "default" }: ChalkSheetProps) {
  const container = useRef<HTMLElement>(null);
  return (
    <span
      ref={(element) => {
        container.current = element?.closest<HTMLElement>("[data-chalk]") ?? element;
      }}
      style={{ display: "contents" }}
    >
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal container={container}>
          <Dialog.Backdrop data-part="sheet-scrim" className="chalk-sheet-scrim" />
          <Dialog.Popup {...(accessibleLabel ? { "aria-label": accessibleLabel, "aria-labelledby": undefined } : {})} data-part={variant === "panel" ? "panel-card" : "sheet"} data-variant={variant} className="chalk-sheet">
            <div data-part="sheet-handle" className="chalk-sheet-handle" />
            {variant !== "details" ? (
              <Dialog.Title className="sr-only">{title}</Dialog.Title>
            ) : (
              <div className="chalk-sheet-heading">
                <Dialog.Title>{title}</Dialog.Title>
                <Dialog.Close data-part="sheet-dismiss" className="chalk-dismiss" aria-label="Close">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 6 12 12M6 18 18 6" />
                  </svg>
                </Dialog.Close>
              </div>
            )}
            {children}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </span>
  );
}
