import { isValidElement, useLayoutEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { Toast } from "./ToastStack";
import { noticeIdentity } from "./notice-announcement";
import { captureToastLayout, measureToastLayout } from "./toast-layout-snapshot";

interface Measurement {
  readonly toast: Toast;
  readonly height: number;
  readonly width: number;
  readonly markup: string;
  readonly snapshot: HTMLDivElement;
}
interface Fit {
  readonly width: number;
  readonly available: number;
  readonly gap: number;
  readonly measurements: ReadonlyMap<string, Measurement>;
}

/** Remember measured sizes when notices fold: resizing must not remount them to measure again. */
export function useToastCapacity(stack: RefObject<HTMLDivElement | null>, candidates: readonly Toast[], enabled: boolean, ownedIds: readonly string[]): { readonly count: number; readonly ready: boolean } {
  const [fit, setFit] = useState<Fit | null>(null);
  let count = candidates.length;
  if (enabled) {
    count = 0;
    let used = 0;
    if (fit)
      for (const toast of candidates.slice().reverse()) {
        const measured = fit.measurements.get(toast.id);
        // Unknown notices get the CSS minimum for their first presentation, not a
        // blanket remount of every known folded caller just to refit one change.
        const height = measured && sameLayout(measured.toast, toast) ? measured.height : 48;
        const next = used + (count ? fit.gap : 0) + height;
        if (fit.width > 0 && next > fit.available) break;
        used = next;
        count += 1;
      }
  }
  const selected = candidates.slice(candidates.length - count);
  const ready =
    fit !== null &&
    selected.every((toast) => {
      const measured = fit.measurements.get(toast.id);
      return measured !== undefined && sameLayout(measured.toast, toast);
    });
  useLayoutEffect(() => {
    const node = stack.current;
    if (!enabled || !node) return;
    const elements = [...node.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    const measure = () => {
      const style = getComputedStyle(node);
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const width = node.clientWidth;
      const gap = parseFloat(style.rowGap) || 0;
      const mounted = selected.filter((toast) => ownedIds.includes(toast.id));
      const reserved = elements.slice(mounted.length);
      const reservedHeight = reserved.reduce((height, element) => height + Math.max(element.offsetHeight, Math.ceil(element.getBoundingClientRect().height)) + gap, 0);
      const available = Math.max(0, node.clientHeight - padding - reservedHeight);
      const updates = new Map<string, Measurement>();
      mounted.forEach((toast, index) => {
        const element = elements[index];
        if (!element) return;
        const height = Math.max(element.offsetHeight, Math.ceil(element.getBoundingClientRect().height));
        const old = fit?.measurements.get(toast.id);
        const markup = element.innerHTML;
        if (!old || old.height !== height || old.width !== width || old.markup !== markup || !sameLayout(old.toast, toast)) {
          updates.set(toast.id, { toast, height, width, markup, snapshot: captureToastLayout(element) });
        }
      });
      for (const toast of candidates) {
        const old = fit?.measurements.get(toast.id);
        if (old && old.width !== width && !mounted.includes(toast) && sameLayout(old.toast, toast)) {
          updates.set(toast.id, { ...old, width, height: measureToastLayout(node, old.snapshot) });
        }
      }
      setFit((previous) => {
        const measurements = new Map(previous?.measurements);
        const present = new Set(candidates.map((toast) => toast.id));
        for (const id of measurements.keys()) if (!present.has(id)) measurements.delete(id);
        const changed = measurements.size !== previous?.measurements.size || updates.size > 0;
        for (const [id, measurement] of updates) measurements.set(id, measurement);
        return !changed && previous?.width === width && previous.available === available && previous.gap === gap ? previous : { width, available, gap, measurements };
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    let active = true;
    const observer = new ResizeObserver(() => {
      if (active) flushSync(measure);
    });
    observer.observe(node);
    for (const element of elements) observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  });
  return { count, ready: !enabled || ready };
}

function sameLayout(previous: Toast, next: Toast): boolean {
  return previous.id === next.id && noticeIdentity(previous) === noticeIdentity(next) && previous.action?.label === next.action?.label && sameLayoutValue(previous.message, next.message) && sameLayoutValue(previous.icon, next.icon);
}

/** Compare element kinds and layout props, not freshly allocated JSX or callback identities. Never invoke a caller component. */
function sameLayoutValue(previous: unknown, next: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(previous, next)) return true;
  if (typeof previous === "function" && typeof next === "function") return true;
  if (previous === null || next === null || typeof previous !== "object" || typeof next !== "object") return false;
  if (isValidElement(previous) || isValidElement(next)) return isValidElement(previous) && isValidElement(next) && previous.type === next.type && sameLayoutValue(previous.props, next.props, seen);
  if (Object.getPrototypeOf(previous) !== Object.getPrototypeOf(next)) return false;
  if (seen.get(previous) === next) return true;
  seen.set(previous, next);
  const keys = Object.keys(previous).filter((key) => key !== "ref");
  return keys.length === Object.keys(next).filter((key) => key !== "ref").length && keys.every((key) => Object.hasOwn(next, key) && sameLayoutValue(Reflect.get(previous, key), Reflect.get(next, key), seen));
}
