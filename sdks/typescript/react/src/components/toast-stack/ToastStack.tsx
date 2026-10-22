import { memo, useLayoutEffect, useRef } from "react";
import { ChalkToast, type ChalkToastProps } from "../chalk-ui/ChalkToast";
import { cn } from "../../utils/cn";
export interface Toast extends Omit<ChalkToastProps, "onDismiss"> {
  readonly id: string;
}
export interface ToastStackProps {
  readonly toasts: readonly Toast[];
  readonly onDismiss: (id: string) => void;
  readonly maxVisible?: number;
  readonly className?: string;
  /** Called with true when even the newest notice has no room on the stage, so the host can offer the notices elsewhere, such as from the header. Without it, the newest notice always shows. */
  readonly onFold?: (folded: boolean) => void;
}
/** Controls a notice must never cover. Board controls are clipped by the board, so only their part inside it counts. */
const RESERVED = ".chalk-frame-header :is(button, a, [role='button']), .chalk-board[data-primary] :is(.chalk-board-zoom, .chalk-board-island, .chalk-board-menu-button, .chalk-board-chip), .chalk-shell-reactions, [data-part='dock']";
export const ToastStack = memo(function ToastStack({ toasts, onDismiss, maxVisible = 3, className, onFold }: ToastStackProps) {
  const stack = useRef<HTMLDivElement>(null);
  const shown = toasts.slice(-maxVisible);
  const fold = useRef(onFold);
  fold.current = onFold;
  const ids = shown.map((toast) => toast.id).join(" ");
  useLayoutEffect(() => {
    const element = stack.current;
    if (!element) return;
    let folded = false;
    const place = () => {
      const next = fitNotices(element, Boolean(fold.current));
      if (next === folded) return;
      folded = next;
      fold.current?.(next);
    };
    place();
    let queued = 0;
    let live = true;
    const queue = () => {
      if (live && !queued) queued = requestAnimationFrame(() => ((queued = 0), place()));
    };
    const frame = element.closest<HTMLElement>("[data-part='call-frame']") ?? element.parentElement;
    const resize = new ResizeObserver(place);
    resize.observe(element);
    if (frame) resize.observe(frame);
    // A notice also widens on its own, such as when the call's font loads.
    for (const notice of element.children) resize.observe(notice);
    if ("fonts" in document) void document.fonts.ready.then(queue);
    // Controls also appear or change place without resizing the stack first, such as the board's menu once the board is ready, or the tools opening and lifting the band's bottom. Refit in the same task, so no click lands while a notice still covers them.
    const changes = new MutationObserver(place);
    if (frame) changes.observe(frame, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "data-place", "data-primary", "data-stage-role", "hidden"] });
    frame?.addEventListener("transitionend", queue);
    return () => {
      live = false;
      resize.disconnect();
      changes.disconnect();
      cancelAnimationFrame(queued);
      frame?.removeEventListener("transitionend", queue);
      if (folded) fold.current?.(false);
    };
  }, [ids]);
  return (
    <div ref={stack} data-part="toast-stack" className={cn("chalk-toasts", className)}>
      {shown.map((toast) => (
        <ChalkToast key={toast.id} {...toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
});

/** Shows the newest notices that fit the stack's band whole and clear of every reserved control, folds the rest, and returns whether none fit. */
function fitNotices(stack: HTMLElement, foldable: boolean): boolean {
  const notices = [...stack.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  for (const notice of notices) notice.removeAttribute("data-folded");
  const band = stack.getBoundingClientRect();
  const style = getComputedStyle(stack);
  const top = band.top + Number.parseFloat(style.paddingTop);
  const bottom = band.bottom - Number.parseFloat(style.paddingBottom);
  const frame = stack.closest("[data-part='call-frame']");
  const reserved = frame ? [...frame.querySelectorAll(RESERVED)].map(visibleBox) : [];
  let fitting = 0;
  for (const notice of notices.slice().reverse()) {
    // Layout offsets, because a notice slides in with a transform.
    const left = band.left + notice.offsetLeft;
    const noticeTop = band.top + notice.offsetTop;
    const box = { left, right: left + notice.offsetWidth, top: noticeTop, bottom: noticeTop + notice.offsetHeight };
    if (box.top < top - 0.5 || box.bottom > bottom + 0.5 || reserved.some((control) => overlaps(box, control))) break;
    fitting += 1;
  }
  if (!foldable) fitting = Math.max(fitting, Math.min(1, notices.length));
  for (const notice of notices.slice(0, notices.length - fitting)) notice.setAttribute("data-folded", "");
  return notices.length > 0 && fitting === 0;
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
