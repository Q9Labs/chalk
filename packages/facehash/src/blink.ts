import type * as React from "react";
import { BLINK_CLOSED_SCALE_Y } from "./core/blink-scale.js";
import type { FacehashBlinkTiming } from "./core/index.js";

const BLINK_KEYFRAMES = `
@keyframes facehash-blink {
  0%, 92%, 100% { transform: scaleY(1); }
  96% { transform: scaleY(${BLINK_CLOSED_SCALE_Y}); }
}
`;

let keyframesInjected = false;

export function ensureBlinkKeyframes(): void {
  if (keyframesInjected || typeof document === "undefined") {
    return;
  }

  const style = document.createElement("style");
  style.textContent = BLINK_KEYFRAMES;
  document.head.appendChild(style);
  keyframesInjected = true;
}

export function getBlinkStyle(enableBlink: boolean | undefined, timing: FacehashBlinkTiming | undefined): React.CSSProperties | undefined {
  if (!(enableBlink && timing)) {
    return;
  }

  return {
    animation: `facehash-blink ${timing.duration}s ease-in-out ${timing.delay}s infinite`,
    transformBox: "fill-box",
    transformOrigin: "center center",
  };
}
