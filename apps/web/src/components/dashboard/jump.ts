import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * A link can name one setting with its hash, such as /dashboard/developer#recording-videos. Once the page has drawn
 * it, this centres that element, moves focus there without scrolling again, and marks it for a moment, so the eye
 * lands on the setting rather than the top of the page.
 */
export function useJumpTarget(ready: boolean) {
  const hash = useRouterState({ select: (state) => state.location.hash });
  useEffect(() => {
    if (!ready || !hash) return;
    const target = document.getElementById(hash);
    if (!target) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    // The mark shows where focus went, so the target needs no focus ring of its own.
    target.dataset.jump = "";
    target.focus({ preventScroll: true });
    target.classList.remove("jumped");
    // Reading the layout restarts the mark when the same link is followed twice.
    void target.offsetWidth;
    target.classList.add("jumped");
    const done = () => target.classList.remove("jumped");
    target.addEventListener("animationend", done, { once: true });
    return () => {
      target.removeEventListener("animationend", done);
      target.classList.remove("jumped");
    };
  }, [ready, hash]);
}
