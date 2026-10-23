import { memo, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChalkToast, ToastFace, type ChalkToastProps } from "../chalk-ui/ChalkToast";
import { cn } from "../../utils/cn";
export interface Toast extends Omit<ChalkToastProps, "onDismiss"> {
  readonly id: string;
}
export interface ToastStackProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
  readonly maxVisible?: number;
  readonly className?: string;
  /** Called with the ids of the notices that have no room on the stage, so the host can offer them elsewhere, such as from the header. Without it, the newest notice always shows. */
  readonly onFold?: (folded: readonly string[]) => void;
}
/** Controls a notice must never cover. Board controls are clipped by the board, so only their part inside it counts. */
const RESERVED = ".chalk-frame-header :is(button, a, [role='button']), .chalk-board[data-primary] :is(.chalk-board-zoom, .chalk-board-island, .chalk-board-menu-button, .chalk-board-chip), .chalk-shell-reactions, [data-part='dock']";
/**
 * Shows each notice as a toast only where it fits whole. To decide, the stack mounts an inert, hidden copy of the newest
 * notices, measures it, and removes it in the same commit, so the copy never paints or doubles a notice's text on the page.
 * Only the notices that fit mount as toasts, so a folded notice runs no timer and has no controls on the page.
 */
export const ToastStack = memo(function ToastStack({ toasts, onDismiss, maxVisible = 3, className, onFold }: ToastStackProps) {
  const stack = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const candidates = toasts.slice(-maxVisible);
  const ids = candidates.map((toast) => toast.id).join(" ");
  const [shownIds, setShownIds] = useState<readonly string[]>([]);
  const [measuredIds, setMeasuredIds] = useState<string | null>(null);
  const [refit, setRefit] = useState(false);
  const measuring = refit || measuredIds !== ids;
  const fold = useRef(onFold);
  fold.current = onFold;
  useLayoutEffect(() => {
    const layer = measure.current;
    if (!measuring || !layer) return;
    const all = ids ? ids.split(" ") : [];
    const next = all.slice(all.length - fitNotices(layer, Boolean(fold.current)));
    setShownIds((current) => (current.join(" ") === next.join(" ") ? current : next));
    setMeasuredIds(ids);
    setRefit(false);
  }, [ids, measuring]);
  const shownKey = shownIds.join(" ");
  useLayoutEffect(() => {
    const layer = measure.current;
    if (!layer) return;
    // Outside React, measure and apply the fit before the next paint or click.
    const place = () => flushSync(() => setRefit(true));
    const frame = layer.closest<HTMLElement>("[data-part='call-frame']") ?? layer.parentElement;
    // Hosts that render in jsdom or on the server have no ResizeObserver, so there the stack keeps its first fit.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    resize?.observe(layer);
    if (frame) resize?.observe(frame);
    // A notice also widens on its own, such as when the call's font loads.
    for (const notice of stack.current?.children ?? []) resize?.observe(notice);
    let live = true;
    if ("fonts" in document) void document.fonts.ready.then(() => live && place());
    // Controls appear or change place without resizing the stack first, such as the board's menu once the board is ready, or the tools opening and lifting the band's bottom. Refit in the same task, so no click lands while a notice still covers them. The hidden copy's own changes don't count.
    const changes =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (records.some((record) => !layer.contains(record.target))) place();
          });
    if (frame) changes?.observe(frame, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "data-place", "data-primary", "data-stage-role", "hidden"] });
    frame?.addEventListener("transitionend", place);
    return () => {
      live = false;
      resize?.disconnect();
      changes?.disconnect();
      frame?.removeEventListener("transitionend", place);
    };
  }, [ids, shownKey]);
  const shown = candidates.filter((toast) => shownIds.includes(toast.id));
  const foldedIds = toasts
    .filter((toast) => !shownIds.includes(toast.id))
    .map((toast) => toast.id)
    .join(" ");
  useLayoutEffect(() => {
    fold.current?.(foldedIds ? foldedIds.split(" ") : []);
  }, [foldedIds]);
  useLayoutEffect(() => () => fold.current?.([]), []);
  return (
    <>
      <div ref={stack} data-part="toast-stack" className={cn("chalk-toasts", className)}>
        {shown.map((toast) => (
          <ChalkToast key={toast.id} {...toast} onDismiss={() => onDismiss(toast.id)} />
        ))}
      </div>
      <div ref={measure} data-measure="" className={cn("chalk-toasts", className)} aria-hidden="true" inert>
        {measuring
          ? candidates.map((toast) => (
              <div key={toast.id} data-type={toast.type ?? "info"} className="chalk-toast">
                <ToastFace message={toast.message} type={toast.type ?? "info"} action={toast.action} icon={toast.icon} onDismiss={() => undefined} />
              </div>
            ))
          : null}
      </div>
    </>
  );
});

/** Counts the newest notices that fit the stack's band whole and clear of every reserved control. */
function fitNotices(layer: HTMLElement, foldable: boolean): number {
  const notices = [...layer.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  const band = layer.getBoundingClientRect();
  const style = getComputedStyle(layer);
  const top = band.top + Number.parseFloat(style.paddingTop);
  const bottom = band.bottom - Number.parseFloat(style.paddingBottom);
  const frame = layer.closest("[data-part='call-frame']");
  const reserved = frame ? [...frame.querySelectorAll(RESERVED)].map(visibleBox) : [];
  let fitting = 0;
  for (const notice of notices.slice().reverse()) {
    // Layout offsets, because a notice slides in with a transform.
    const left = band.left + notice.offsetLeft;
    const noticeTop = band.top + notice.offsetTop;
    const box = { left, right: left + notice.offsetWidth, top: noticeTop, bottom: noticeTop + notice.offsetHeight };
    // Content wider or taller than its box would spill text or controls out of the notice.
    const spills = notice.scrollWidth > notice.clientWidth + 1 || notice.scrollHeight > notice.clientHeight + 1;
    const outside = box.top < top - 0.5 || box.bottom > bottom + 0.5 || box.left < band.left - 0.5 || box.right > band.right + 0.5;
    if (spills || outside || reserved.some((control) => overlaps(box, control))) break;
    fitting += 1;
  }
  return foldable ? fitting : Math.max(fitting, Math.min(1, notices.length));
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function visibleBox(element: Element): Box {
  const box = element.getBoundingClientRect();
  const board = element.closest(".chalk-board")?.getBoundingClientRect();
  if (!board) return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  return { left: Math.max(box.left, board.left), right: Math.min(box.right, board.right), top: Math.max(box.top, board.top), bottom: Math.min(box.bottom, board.bottom) };
}

function overlaps(a: Box, b: Box) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
