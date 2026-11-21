import { useEffect, useRef, type ReactNode } from "react";

import { entrySender } from "./boot-beacon";

/**
 * A surface fact is shown when actually painted: the element must intersect the viewport once. Renders nothing
 * itself; wraps the surface's own element.
 */
export function EntrySurface({ name, fields, children }: { name: string; fields?: Record<string, unknown>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let dismissed: (() => void) | undefined;
    const show = () => {
      if (dismissed !== undefined) return;
      dismissed = entrySender().surface(name, { ...fields, shown: true }).dismiss;
    };
    if (typeof IntersectionObserver !== "function") {
      const raf = requestAnimationFrame(show);
      return () => {
        cancelAnimationFrame(raf);
        dismissed?.();
      };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) show();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      dismissed?.();
    };
    // A surface's fields are fixed for its mount; re-declaring them would re-show the surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  return <div ref={ref}>{children}</div>;
}
