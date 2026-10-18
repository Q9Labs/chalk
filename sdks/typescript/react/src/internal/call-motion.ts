import { useEffect, useState, type RefObject } from "react";
import { useMediaQuery } from "./useMediaQuery";
const moves = new WeakMap<HTMLElement, Animation>();
/** Measure all old boxes before the layout update, then call play after the DOM commit. */
export function captureFlip(elements: Iterable<HTMLElement>): () => void {
  const previous = Array.from(elements, (element) => ({ element, box: element.getBoundingClientRect() }));
  return () => {
    for (const { element } of previous) moves.get(element)?.cancel();
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const next = previous.filter(({ element }) => element.isConnected).map((item) => ({ ...item, next: item.element.getBoundingClientRect() }));
    for (const { element, box, next: boxAfter } of next) {
      if (!boxAfter.width || !boxAfter.height || !box.width || !box.height) continue;
      const animation = element.animate(
        [
          { transformOrigin: "0 0", transform: `translate(${box.x - boxAfter.x}px, ${box.y - boxAfter.y}px) scale(${box.width / boxAfter.width}, ${box.height / boxAfter.height})` },
          { transformOrigin: "0 0", transform: "none" },
        ],
        { duration: 220, easing: "cubic-bezier(.16,1,.3,1)" },
      );
      moves.set(element, animation);
    }
  };
}
/** Chrome stays visible while a layer is open, on touch, and for keyboard focus. */
export function useIdleChrome(root: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [idle, setIdle] = useState(false);
  const fine = useMediaQuery("(pointer:fine)");
  useEffect(() => {
    const element = root.current;
    if (!element || !enabled || !fine) return;
    let timer: ReturnType<typeof setTimeout>;
    const poke = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const layer = element.querySelector('[role="menu"],[role="dialog"],[data-part="toast"],[data-chalk-drawer]');
        const focused = element.querySelector(".chalk-frame-header :focus-visible,.chalk-frame-dock :focus-visible");
        if (!layer && !focused) setIdle(true);
        else poke();
      }, 3000);
    };
    for (const event of ["pointermove", "pointerdown", "keydown", "focusin"]) element.addEventListener(event, poke);
    const observer = new MutationObserver((records) => {
      const selector = '[role="menu"],[role="dialog"],[data-part="toast"],[data-chalk-drawer]';
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector))))) poke();
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
