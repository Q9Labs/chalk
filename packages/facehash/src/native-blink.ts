import { useEffect, useState } from "react";
import type { EyeAnchor, FacehashBlinkTiming } from "./core";

const CLOSED_SCALE_Y = 0.05;
const BLINK_CLOSED_MS = 85;

export function buildEyeTransform(anchor: EyeAnchor, scaleY: number): string {
  return `translate(${anchor.x} ${anchor.y}) scale(1 ${scaleY}) translate(${-anchor.x} ${-anchor.y})`;
}

export function useBlinkTransform(enableBlink: boolean | undefined, timing: FacehashBlinkTiming | undefined, anchor: EyeAnchor): string {
  const [scaleY, setScaleY] = useState(1);

  useEffect(() => {
    if (!(enableBlink && timing)) {
      setScaleY(1);
      return undefined;
    }

    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    let openTimeout: ReturnType<typeof setTimeout> | undefined;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    const blink = () => {
      if (cancelled) {
        return;
      }
      setScaleY(CLOSED_SCALE_Y);
      openTimeout = setTimeout(() => {
        if (!cancelled) {
          setScaleY(1);
        }
      }, BLINK_CLOSED_MS);
    };

    closeTimeout = setTimeout(() => {
      blink();
      intervalId = setInterval(blink, timing.duration * 1000);
    }, timing.delay * 1000);

    return () => {
      cancelled = true;
      if (closeTimeout) {
        clearTimeout(closeTimeout);
      }
      if (openTimeout) {
        clearTimeout(openTimeout);
      }
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [enableBlink, timing]);

  return buildEyeTransform(anchor, scaleY);
}
