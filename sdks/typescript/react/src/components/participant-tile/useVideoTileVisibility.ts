import { setVideoTileVisibility } from "@q9labsai/chalk-client";
import { useEffect, type RefObject } from "react";

// A tile this close to the viewport counts as on screen, so its video is pulled before it scrolls in.
const EARLY_PULL_MARGIN = "50%";

/**
 * Tells the media client whether a remote video tile is on screen, keyed by its publication, so video nobody can see
 * is not pulled. `onScreen` is false for a tile its layout keeps mounted but off the page.
 */
export function useVideoTileVisibility(elementRef: RefObject<HTMLElement | null>, publicationId: string | undefined, onScreen: boolean): void {
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Observe the tile element's intersection and size; report the tile hidden when it unmounts or leaves the page.
  useEffect(() => {
    const element = elementRef.current;
    if (!publicationId) return;
    if (!element || !onScreen) {
      setVideoTileVisibility(publicationId, null);
      return;
    }
    let intersecting = typeof IntersectionObserver === "undefined";
    let size = devicePixels(element.getBoundingClientRect());
    const report = () => setVideoTileVisibility(publicationId, intersecting ? size : null);
    const intersection =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              const entry = entries.at(-1);
              if (!entry) return;
              intersecting = entry.isIntersecting;
              report();
            },
            { rootMargin: EARLY_PULL_MARGIN },
          );
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(([entry]) => {
            if (!entry) return;
            size = devicePixels(entry.contentRect);
            report();
          });
    intersection?.observe(element);
    resize?.observe(element);
    if (!intersection) report();
    return () => {
      intersection?.disconnect();
      resize?.disconnect();
      setVideoTileVisibility(publicationId, null);
    };
  }, [elementRef, onScreen, publicationId]);
}

function devicePixels({ width, height }: { readonly width: number; readonly height: number }) {
  const scale = window.devicePixelRatio || 1;
  return { width: width * scale, height: height * scale };
}
