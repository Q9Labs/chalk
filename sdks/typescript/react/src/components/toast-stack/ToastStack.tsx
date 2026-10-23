import { memo, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { ChalkToast, type ChalkToastProps } from "../chalk-ui/ChalkToast";
import { cn } from "../../utils/cn";
export interface Toast extends Omit<ChalkToastProps, "onDismiss" | "announce"> {
  readonly id: string;
}
export interface ToastStackProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
  readonly maxVisible?: number;
  readonly className?: string;
  /**
   * Called with the ids of the notices the stage has no room for, so the host can offer them elsewhere, such as from the header.
   * With it, a call shorter than `FOLD_BELOW_PX` folds every notice and a taller one folds those past `maxVisible`, and the stack announces each folded notice once.
   */
  readonly onFold?: (folded: readonly string[]) => void;
}
/**
 * Calls shorter than this fold every notice. It is the height the mockup's three-notice stack needs at its tallest, on a phone with
 * the board open: 108px for the header and the board's menu, an 8px gap, three camera errors wrapped to three lines (79px each, with
 * 8px gaps), and the 242px the open drawing tools lift notices by, 611px in all.
 */
export const FOLD_BELOW_PX = 620;
export const ToastStack = memo(function ToastStack({ toasts, onDismiss, maxVisible = 3, className, onFold }: ToastStackProps) {
  const stack = useRef<HTMLDivElement>(null);
  const short = useShortCall(stack, onFold !== undefined);
  // Until the call's height is known, a folding stack shows nothing, so no notice mounts and then folds.
  const shown = onFold !== undefined && short !== false ? [] : toasts.slice(-maxVisible);
  const folded = onFold !== undefined && short !== null ? toasts.filter((toast) => !shown.includes(toast)) : [];
  const foldedIds = folded.map((toast) => toast.id);
  // Each notice is announced once: by its toast if it shows first, or by the announcer if it folds first.
  const announced = useRef(new Set<string>());
  const [unheard, setUnheard] = useState<readonly string[]>([]);
  const reported = useRef<readonly string[]>([]);
  const fold = useRef(onFold);
  fold.current = onFold;
  useLayoutEffect(() => {
    if (!fold.current) return;
    const present = new Set(toasts.map((toast) => toast.id));
    for (const id of announced.current) if (!present.has(id)) announced.current.delete(id);
    const fresh = foldedIds.filter((id) => !announced.current.has(id));
    for (const id of [...foldedIds, ...shown.map((toast) => toast.id)]) announced.current.add(id);
    // A notice leaves the announcer once it shows or goes, so folding again doesn't read it twice.
    const kept = unheard.filter((id) => foldedIds.includes(id));
    if (fresh.length) setUnheard(fresh);
    else if (kept.length < unheard.length) setUnheard(kept);
    if (sameIds(reported.current, foldedIds)) return;
    reported.current = foldedIds;
    fold.current(foldedIds);
  });
  useLayoutEffect(
    () => () => {
      reported.current = [];
      fold.current?.([]);
    },
    [],
  );
  const announcing = folded.filter((toast) => unheard.includes(toast.id));
  return (
    <>
      <div ref={stack} data-part="toast-stack" className={cn("chalk-toasts", className)}>
        {shown.map((toast) => (
          <ChalkToast key={toast.id} {...toast} announce={!announced.current.has(toast.id)} onDismiss={() => onDismiss(toast.id)} />
        ))}
      </div>
      {onFold ? (
        // Live regions without the status and alert roles, so a query for a toast's role finds only toasts.
        <div data-part="notice-announcer" className="sr-only">
          <div aria-live="polite">
            {announcing
              .filter((toast) => toast.type !== "error")
              .map((toast) => (
                <div key={toast.id}>{toast.message}</div>
              ))}
          </div>
          <div aria-live="assertive">
            {announcing
              .filter((toast) => toast.type === "error")
              .map((toast) => (
                <div key={toast.id}>{toast.message}</div>
              ))}
          </div>
        </div>
      ) : null}
    </>
  );
});

/** Whether the call holding the stack is shorter than `FOLD_BELOW_PX`, or null until known. A call with no layout, as in jsdom tests and server rendering, counts as tall. */
function useShortCall(stack: RefObject<HTMLElement | null>, enabled: boolean): boolean | null {
  const [short, setShort] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    if (!enabled) return;
    const call = stack.current?.closest<HTMLElement>("[data-part='call-frame']");
    const read = () => setShort(Boolean(call && call.clientHeight > 0 && call.clientHeight < FOLD_BELOW_PX));
    read();
    if (!call || typeof ResizeObserver === "undefined") return;
    // Fold in the same frame as the resize, so a notice never paints over a control that just moved.
    const observer = new ResizeObserver(() => flushSync(read));
    observer.observe(call);
    return () => observer.disconnect();
  }, [stack, enabled]);
  return short;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
