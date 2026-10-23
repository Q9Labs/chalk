import { memo, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { ChalkToast, type ChalkToastProps } from "../chalk-ui/ChalkToast";
import { cn } from "../../utils/cn";
import { noticeAnnouncement, noticeIdentity } from "./notice-announcement";
import { useToastCapacity } from "./useToastCapacity";
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
   * With it, a call shorter than `FOLD_BELOW_PX` folds every notice. Taller calls fold notices past `maxVisible` or outside the available band, announcing each folded message once.
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
  const candidates = maxVisible > 0 ? toasts.slice(-maxVisible) : [];
  const [ownedIds, setOwnedIds] = useState<readonly string[]>([]);
  const fold = useRef(onFold);
  const capacity = useToastCapacity(stack, candidates, onFold !== undefined && short === false, ownedIds);
  const selected = onFold !== undefined && short !== false ? [] : candidates.slice(candidates.length - capacity.count);
  // Relinquish the header's ownership before adding a caller tree to the stage.
  // The callback and this state update commit together in the host, avoiding a
  // second resource instance even for one synchronous layout-effect commit.
  const shown = onFold || fold.current ? selected.filter((toast) => ownedIds.includes(toast.id)) : selected;
  const folded = onFold !== undefined && short !== null ? toasts.filter((toast) => !selected.includes(toast)) : [];
  const foldedIds = folded.map((toast) => toast.id);
  // Each message is announced once, even when a host reuses a notice id for a new failure.
  const announced = useRef(new Map<string, string>());
  const wasAnnounced = (toast: Toast) => announced.current.get(toast.id) === noticeIdentity(toast);
  const [unheard, setUnheard] = useState<readonly string[]>([]);
  const reported = useRef<readonly string[]>([]);
  const reporting = useRef(false);
  useLayoutEffect(() => {
    const replacement = fold.current !== onFold;
    if (replacement) {
      if (!onFold) fold.current?.([]);
      fold.current = onFold;
    }
    const selectedIds = selected.map((toast) => toast.id);
    setOwnedIds((previous) => (sameIds(previous, selectedIds) ? previous : selectedIds));
    const unchanged = sameIds(reported.current, foldedIds);
    if (!unchanged) reported.current = foldedIds;
    // A callback can update its host and be recreated by that update. Do not echo
    // the same snapshot back during that notification's synchronous commit.
    if (!unchanged || (replacement && !reporting.current)) {
      reporting.current = true;
      queueMicrotask(() => {
        reporting.current = false;
      });
      fold.current?.(reported.current);
    }
    if (!capacity.ready) return;
    const present = new Set(toasts.map((toast) => toast.id));
    for (const id of announced.current.keys()) if (!present.has(id)) announced.current.delete(id);
    const eligible = onFold ? toasts : shown;
    const fresh = eligible.filter((toast) => !wasAnnounced(toast)).map((toast) => toast.id);
    for (const toast of eligible) announced.current.set(toast.id, noticeIdentity(toast));
    // Keep the last announcement unchanged across stage/header moves. Only a
    // new semantic message or removal mutates this text-only live region.
    const kept = unheard.filter((id) => eligible.some((toast) => toast.id === id));
    if (fresh.length) setUnheard(fresh);
    else if (kept.length < unheard.length) setUnheard(kept);
  });
  useLayoutEffect(
    () => () => {
      reported.current = [];
      fold.current?.([]);
    },
    [],
  );
  const announcing = (onFold ? toasts : shown).filter((toast) => unheard.includes(toast.id));
  return (
    <>
      <div ref={stack} data-part="toast-stack" className={cn("chalk-toasts", className)}>
        {shown.map((toast) => (
          <ChalkToast key={toast.id} {...toast} announce={toast.announcementText === undefined && noticeAnnouncement(toast) === ""} onDismiss={() => onDismiss(toast.id)} />
        ))}
      </div>
      {/* Text speech is independent of presentation. Opaque messages without speech text keep their visible live-region fallback. */}
      <div data-part="notice-announcer" className="sr-only">
        <div aria-live="polite">
          {announcing
            .filter((toast) => toast.type !== "error")
            .map((toast) => (
              <div key={JSON.stringify([toast.id, noticeIdentity(toast)])}>{noticeAnnouncement(toast)}</div>
            ))}
        </div>
        <div aria-live="assertive">
          {announcing
            .filter((toast) => toast.type === "error")
            .map((toast) => (
              <div key={JSON.stringify([toast.id, noticeIdentity(toast)])}>{noticeAnnouncement(toast)}</div>
            ))}
        </div>
      </div>
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
