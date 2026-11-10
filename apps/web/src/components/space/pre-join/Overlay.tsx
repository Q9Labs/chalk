import { useEffect, useRef, type ReactNode } from "react";

/** Keeps the last control clear of the home indicator on a phone. */
export const SAFE_BOTTOM = { paddingBottom: "max(env(safe-area-inset-bottom), var(--space-6))" } as const;

/** Closes on Escape, and on a press outside the element the returned ref is attached to. */
export function useDismiss<Element extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<Element>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) latest.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current();
    };
    document.addEventListener("pointerdown", press);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return ref;
}

/** A bottom sheet over a scrim. It keeps the step free of a dialog library, which the first screen would otherwise download. */
export function BottomSheet({ label, onClose, children }: { readonly label: string; readonly onClose: () => void; readonly children: ReactNode }) {
  const panel = useDismiss<HTMLDivElement>(true, onClose);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [dom] Move focus into the sheet when it opens so keyboard users land inside it.
  useEffect(() => panel.current?.focus(), [panel]);
  return (
    <div className="fixed inset-0 z-50 flex items-end" style={{ backgroundColor: "var(--chalk-scrim)" }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="max-h-full w-full overflow-y-auto border-t border-[var(--chalk-line)] bg-[var(--chalk-popover)] text-[var(--chalk-text)] outline-none"
        style={{ borderRadius: "var(--corner-3xl) var(--corner-3xl) 0 0", ...SAFE_BOTTOM }}
      >
        <div aria-hidden="true" className="mx-auto mb-2 mt-2 h-1 w-9 rounded-full bg-[var(--chalk-line-strong)]" />
        {children}
      </div>
    </div>
  );
}
