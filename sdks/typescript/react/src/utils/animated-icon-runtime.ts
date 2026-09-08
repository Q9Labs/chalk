"use client";

import type { LegacyAnimationControls } from "motion/react";
import { useReducedMotion } from "motion/react";
import type { ForwardedRef, MouseEventHandler } from "react";
import { useCallback, useEffect, useImperativeHandle, useRef } from "react";

export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface UseIconAnimationOptions<T extends Element> {
  controls: LegacyAnimationControls;
  loops?: boolean;
  onMouseEnter?: MouseEventHandler<T>;
  onMouseLeave?: MouseEventHandler<T>;
  ref: ForwardedRef<AnimatedIconHandle>;
}

const INTERACTIVE_CONTROL_SELECTOR = 'button, a, [role="button"], [role="link"]';
const ANIMATED_ICON_SELECTOR = '[data-hugeicons-animated="true"]';
let parentHoverBridgeInstalled = false;
let dispatchingParentHover = false;

function dispatchAnimatedIconEvent(control: Element, type: "mouseover" | "mouseout") {
  const animatedIcons = control.querySelectorAll<HTMLElement>(ANIMATED_ICON_SELECTOR);

  if (animatedIcons.length === 0) return;

  dispatchingParentHover = true;
  try {
    animatedIcons.forEach((icon) => {
      icon.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
      icon.querySelectorAll<HTMLElement>("svg").forEach((svg) => {
        svg.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
      });
    });
  } finally {
    dispatchingParentHover = false;
  }
}

function installParentHoverBridge() {
  if (parentHoverBridgeInstalled || typeof document === "undefined") return;

  parentHoverBridgeInstalled = true;

  document.addEventListener(
    "mouseover",
    (event) => {
      if (dispatchingParentHover || !(event.target instanceof Element)) return;

      const control = event.target.closest(INTERACTIVE_CONTROL_SELECTOR);
      if (!control || (event.relatedTarget instanceof Node && control.contains(event.relatedTarget))) return;

      dispatchAnimatedIconEvent(control, "mouseover");
    },
    true,
  );

  document.addEventListener(
    "mouseout",
    (event) => {
      if (dispatchingParentHover || !(event.target instanceof Element)) return;

      const control = event.target.closest(INTERACTIVE_CONTROL_SELECTOR);
      if (!control || (event.relatedTarget instanceof Node && control.contains(event.relatedTarget))) return;

      dispatchAnimatedIconEvent(control, "mouseout");
    },
    true,
  );

  document.addEventListener(
    "focusin",
    (event) => {
      if (dispatchingParentHover || !(event.target instanceof Element)) return;

      const control = event.target.closest(INTERACTIVE_CONTROL_SELECTOR);
      if (control) dispatchAnimatedIconEvent(control, "mouseover");
    },
    true,
  );

  document.addEventListener(
    "focusout",
    (event) => {
      if (dispatchingParentHover || !(event.target instanceof Element)) return;

      const control = event.target.closest(INTERACTIVE_CONTROL_SELECTOR);
      if (!control || (event.relatedTarget instanceof Node && control.contains(event.relatedTarget))) return;

      dispatchAnimatedIconEvent(control, "mouseout");
    },
    true,
  );
}

export function useIconAnimation<T extends Element>({ controls, loops = false, onMouseEnter, onMouseLeave, ref }: UseIconAnimationOptions<T>) {
  useEffect(() => {
    installParentHoverBridge();
  }, []);

  const shouldReduceMotion = useReducedMotion();
  const isControlledRef = useRef(false);
  const isPlayingRef = useRef(false);
  const runRef = useRef(0);

  const startAnimation = useCallback(() => {
    if (shouldReduceMotion || isPlayingRef.current) return;

    isPlayingRef.current = true;
    const run = ++runRef.current;
    controls.set("normal");
    void controls.start("animate").then(() => {
      if (runRef.current === run) isPlayingRef.current = false;
    });
  }, [controls, shouldReduceMotion]);

  const stopAnimation = useCallback(() => {
    if (!loops) return;

    runRef.current++;
    isPlayingRef.current = false;
    void controls.start("normal");
  }, [controls, loops]);

  useImperativeHandle(ref, () => {
    isControlledRef.current = true;
    return { startAnimation, stopAnimation };
  }, [startAnimation, stopAnimation]);

  const handleMouseEnter = useCallback<MouseEventHandler<T>>(
    (event) => {
      onMouseEnter?.(event);
      if (!isControlledRef.current) startAnimation();
    },
    [onMouseEnter, startAnimation],
  );

  const handleMouseLeave = useCallback<MouseEventHandler<T>>(
    (event) => {
      onMouseLeave?.(event);
      if (!isControlledRef.current) stopAnimation();
    },
    [onMouseLeave, stopAnimation],
  );

  return { handleMouseEnter, handleMouseLeave };
}
