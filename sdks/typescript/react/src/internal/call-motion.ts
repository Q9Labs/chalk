import { useEffect, useState, type RefObject } from "react";
import { useMediaQuery } from "./useMediaQuery";
const moves = new WeakMap<HTMLElement, Animation>();
/** Measure all old boxes before the layout update, then call play after the DOM commit. */
export function captureFlip(elements: Iterable<HTMLElement>): () => void {
  const previous = Array.from(elements, (element) => ({ element, box: element.getBoundingClientRect() }));
  return () => playFlip(previous);
}
function playFlip(previous: readonly { element: HTMLElement; box: DOMRect }[]): { element: HTMLElement; box: DOMRect }[] {
  for (const { element } of previous) moves.get(element)?.cancel();
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const next = previous.filter(({ element }) => element.isConnected).map((item) => ({ ...item, next: item.element.getBoundingClientRect(), transform: getComputedStyle(item.element).transform }));
  for (const { element, box, next: boxAfter, transform } of next) {
    if (reduced) continue;
    if (!boxAfter.width || !boxAfter.height || !box.width || !box.height) continue;
    if (Math.abs(box.x - boxAfter.x) < 0.5 && Math.abs(box.y - boxAfter.y) < 0.5 && Math.abs(box.width - boxAfter.width) < 0.5 && Math.abs(box.height - boxAfter.height) < 0.5) continue;
    const base = transform === "none" ? "" : transform;
    const animation = element.animate(
      [
        { transformOrigin: "0 0", transform: `translate(${box.x - boxAfter.x}px, ${box.y - boxAfter.y}px) ${base} scale(${box.width / boxAfter.width}, ${box.height / boxAfter.height})` },
        { transformOrigin: "0 0", transform },
      ],
      { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
    moves.set(element, animation);
  }
  return next.map(({ element, next: box }) => ({ element, box }));
}
/** Bridge the current stage fitter to FLIP; the stage lane can call captureFlip directly around its own commits. */
export function useStageRefit(root: RefObject<HTMLElement | null>): void {
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing browser motion preference and animation cleanup.
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    let previous: { element: HTMLElement; box: DOMRect }[] = [];
    const measure = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="stage"] > div > *'), (element) => ({ element, box: element.getBoundingClientRect() }));
    previous = measure();
    const observer = new MutationObserver((records) => {
      if (!records.some((record) => record.type === "childList" || (record.target instanceof Element && record.target.matches('[data-testid="stage"] > div > *')))) return;
      const old = new Map(previous.map(({ element, box }) => [element, box]));
      previous = playFlip(measure().map(({ element, box }) => ({ element, box: old.get(element) ?? box })));
    });
    observer.observe(container, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const { element } of previous) moves.get(element)?.cancel();
    };
  }, [root]);
}
// Folded notices count as an open layer, because the header's notice button is the only way to reach them.
const ACTIVE_LAYERS = '[role="menu"],[role="dialog"],[data-part="toast"],[data-part="notice-button"],[data-chalk-drawer]';
/** Chrome stays visible while a layer is open, on touch, and for keyboard focus. */
export function useIdleChrome(root: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  const fine = useMediaQuery("(pointer:fine) and (min-width:641px)");
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing browser motion preference and animation cleanup.
  useEffect(() => {
    const element = root.current;
    if (!element || !enabled || !fine) return;
    let timer: ReturnType<typeof setTimeout>;
    const poke = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const layer = element.querySelector(ACTIVE_LAYERS);
        const focused = element.querySelector(".chalk-frame-header :focus-visible,.chalk-frame-dock :focus-visible");
        if (!layer && !focused) setIdle(true);
        else poke();
      }, 3000);
    };
    for (const event of ["pointermove", "pointerdown", "keydown", "focusin"]) element.addEventListener(event, poke);
    const observer = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches(ACTIVE_LAYERS) || node.querySelector(ACTIVE_LAYERS))))) poke();
    });
    observer.observe(element, { childList: true, subtree: true });
    poke();
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      for (const event of ["pointermove", "pointerdown", "keydown", "focusin"]) element.removeEventListener(event, poke);
    };
  }, [root, enabled, fine]);
  return enabled && fine && idle;
}
