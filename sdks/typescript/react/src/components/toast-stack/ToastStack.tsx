import { memo, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ChalkToast, type ChalkToastProps } from "../chalk-ui/ChalkToast";
import { cn } from "../../utils/cn";
import { mergeRepeats, noticeAnnouncement, noticeIdentity } from "./notice-announcement";
import { useToastCapacity } from "./useToastCapacity";
export interface Toast extends Omit<ChalkToastProps, "onDismiss" | "announce"> {
  readonly id: string;
}
export interface ToastStackProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
  /** At most three: a fourth notice would cover the call it reports on. */
  readonly maxVisible?: number;
  readonly className?: string;
  readonly children?: ReactNode;
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
export const ToastStack = memo(function ToastStack({ toasts: all, onDismiss, maxVisible = 3, className, onFold, children }: ToastStackProps) {
  const groups = mergeRepeats(all);
  const toasts = groups.map((group) => group.notice);
  const dismiss = (id: string) => {
    for (const each of groups.find((group) => group.notice.id === id)?.ids ?? [id]) onDismiss(each);
  };
  const stack = useRef<HTMLDivElement>(null);
  const short = useShortCall(stack, onFold !== undefined);
  // Until the call's height is known, a folding stack shows nothing, so no notice mounts and then folds.
  const candidates = maxVisible > 0 ? toasts.slice(-Math.min(maxVisible, 3)) : [];
  const [ownedIds, setOwnedIds] = useState<readonly string[]>([]);
  const fold = useRef(onFold);
  const capacity = useToastCapacity(stack, candidates, onFold !== undefined && short === false, ownedIds);
  const selected = onFold !== undefined && short !== false ? [] : candidates.slice(candidates.length - capacity.count);
  // Relinquish the header's ownership before adding a caller tree to the stage.
  // The callback and this state update commit together in the host, avoiding a
  // second resource instance even for one synchronous layout-effect commit.
  const shown = onFold || fold.current ? selected.filter((toast) => ownedIds.includes(toast.id)) : selected;
  const folded = onFold !== undefined && short !== null ? toasts.filter((toast) => !selected.includes(toast)) : [];
  const foldedIds = groups.filter((group) => folded.includes(group.notice)).flatMap((group) => group.ids);
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
      <style href="chalk-toast-stack" precedence="default">
        {STACK_CSS}
      </style>
      <div ref={stack} data-part="toast-stack" className={cn("chalk-toasts", className)}>
        {shown.map((toast) => (
          <ChalkToast key={toast.id} {...toast} announce={toast.announcementText === undefined && noticeAnnouncement(toast) === ""} onDismiss={() => dismiss(toast.id)} />
        ))}
        {children}
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
    if (!enabled) {
      setShort(null);
      return;
    }
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

/* A call notice reads in two lines at most: it is as wide as the call allows (560px at most) and wraps evenly. On a phone, a notice with an action puts the pill under its sentence, so the sentence keeps the width. An open sheet owns the phone screen, so notices wait under it. */
const PHONE_CSS = `
  .chalk-toasts .chalk-toast:has(> .chalk-pill-button) {display:grid;grid-template-columns:auto minmax(0, 1fr) auto;align-items:start;row-gap:var(--space-1);padding-block:var(--space-2);}
  .chalk-toasts .chalk-toast:has(> .chalk-pill-button) > [data-part="toast-icon"] {grid-row:1;grid-column:1;}
  .chalk-toasts .chalk-toast:has(> .chalk-pill-button) > [data-part="toast-message"] {grid-row:1;grid-column:2;align-self:center;}
  .chalk-toasts .chalk-toast:has(> .chalk-pill-button) > .chalk-pill-button {grid-row:2;grid-column:2;justify-self:start;margin-bottom:var(--space-0-5);}
  .chalk-toasts .chalk-toast:has(> .chalk-pill-button) > .chalk-dismiss {grid-row:1;grid-column:3;}
`;
const STACK_CSS = `.chalk-toasts .chalk-toast {max-width:min(560px, calc(100% - 32px));}
.chalk-toasts [data-part="toast-message"] {text-wrap:pretty;}
[data-chalk]:has(.chalk-sheet[data-open]:not([data-variant="reactions"])) .chalk-toasts {z-index:40;}
@media (max-width: 640px) {${PHONE_CSS}}
@container chalk-call (max-width: 640px) {${PHONE_CSS}}
`;
