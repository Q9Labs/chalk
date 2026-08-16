import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

export interface ChalkDimensions {
  readonly width: number;
  readonly height: number;
}

export const DEFAULT_CHALK_DIMENSIONS: ChalkDimensions = { width: 120, height: 36 };

function normaliseDimensions(value: ChalkDimensions): ChalkDimensions {
  return {
    width: Number.isFinite(value.width) && value.width > 0 ? value.width : DEFAULT_CHALK_DIMENSIONS.width,
    height: Number.isFinite(value.height) && value.height > 0 ? value.height : DEFAULT_CHALK_DIMENSIONS.height,
  };
}

export function useResizeObserver<T extends Element>(fallback: ChalkDimensions = DEFAULT_CHALK_DIMENSIONS): { ref: RefObject<T | null>; dimensions: ChalkDimensions } {
  const stableFallback = normaliseDimensions(fallback);
  const [dimensions, setDimensions] = useState(stableFallback);
  const ref = useRef<T>(null);

  useEffect(() => {
    setDimensions(stableFallback);
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry ? normaliseDimensions({ width: entry.contentRect.width, height: entry.contentRect.height }) : stableFallback;
      setDimensions((current) => (current.width === next.width && current.height === next.height ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [stableFallback.height, stableFallback.width]);

  return { ref, dimensions };
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionSnapshot(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia(REDUCED_MOTION_QUERY).matches;
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof matchMedia === "undefined") return () => undefined;
  const media = matchMedia(REDUCED_MOTION_QUERY);
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }
  media.addListener(onChange);
  return () => media.removeListener(onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot, () => false);
}
