import { useLayoutEffect, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { Toast } from "./ToastStack";
import { noticeAnnouncement } from "./notice-announcement";

/** Measure the actual mounted suffix, never a second copy of caller content. */
export function useToastCapacity(stack: RefObject<HTMLDivElement | null>, candidates: readonly Toast[], enabled: boolean): { readonly count: number; readonly ready: boolean } {
  const source = JSON.stringify(candidates.map((toast) => [toast.id, noticeAnnouncement(toast), toast.type, toast.announcementKey]));
  const [fit, setFit] = useState<{ readonly source: string; readonly count: number } | null>(null);
  const current = fit?.source === source;
  useLayoutEffect(() => {
    const node = stack.current;
    if (!enabled || !node) return;
    const elements = [...node.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
    const dimensions = () => {
      const style = getComputedStyle(node);
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      return { width: node.clientWidth, available: Math.max(0, node.clientHeight - padding), gap: parseFloat(style.rowGap) || 0, heights: elements.map((element) => Math.max(element.offsetHeight, Math.ceil(element.getBoundingClientRect().height))) };
    };
    const measured = dimensions();
    // No browser layout, as in SSR/happy-dom: preserve the configured count.
    let count = measured.width === 0 ? candidates.length : 0;
    let used = 0;
    if (measured.width > 0) {
      for (const height of measured.heights.toReversed()) {
        const next = used + (count ? measured.gap : 0) + height;
        if (next > measured.available) break;
        used = next;
        count += 1;
      }
    }
    setFit((previous) => (previous?.source === source && previous.count === count ? previous : { source, count }));
    if (typeof ResizeObserver === "undefined") return;
    let active = true;
    const observer = new ResizeObserver(() => {
      if (!active || JSON.stringify(dimensions()) === JSON.stringify(measured)) return;
      // A changed band or message height gets a fresh fit in the same frame.
      flushSync(() => setFit(null));
    });
    observer.observe(node);
    for (const element of elements) observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  });
  return { count: enabled && current ? fit.count : candidates.length, ready: !enabled || current };
}
