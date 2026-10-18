import type { EdgeInsets } from "react-native-safe-area-context";
import type { Frame } from "../motion/MovingFrame";

/**
 * How the call is arranged, as in the mockup's `mode()`:
 * - `portrait`: a phone held upright, or an iPad in narrow Split View.
 * - `landscape`: a phone on its side; the stage takes the screen and the controls fade (L1).
 * - `pad`: an iPad (or a large tablet) with the laptop arrangement and the side card.
 */
export type Arrangement = "portrait" | "landscape" | "pad";

/** The narrowest width that gets the laptop arrangement; Split View at 320 or 375 pt falls back to the phone. */
const PAD_MIN_WIDTH = 600;

export function arrangementFor(width: number, height: number): Arrangement {
  if (width >= PAD_MIN_WIDTH && Math.min(width, height) >= PAD_MIN_WIDTH) return "pad";
  return width > height ? "landscape" : "portrait";
}

export type FrameRegions = {
  readonly header: Frame;
  readonly stage: Frame;
  readonly dock: Frame;
};

/** Gap between tiles, and between the stage and the screen's sides on a phone. */
export const STAGE_GAP = 8;

/**
 * The header, stage and dock boxes for each arrangement, in screen points, from the mockup's
 * `stageRect()` and chrome CSS. The stage never changes when the controls fade.
 * `cardOpen` is the iPad side card, which takes 352 pt from the stage.
 */
export function frameRegions(arrangement: Arrangement, width: number, height: number, insets: EdgeInsets, cardOpen = false): FrameRegions {
  const { top, bottom, left, right } = insets;
  if (arrangement === "portrait") {
    const headerHeight = 52;
    const dockHeight = 52;
    // The dock sits 8 pt above the safe area, plus 6 pt for the label under the audio output button (R1).
    const dockBottom = bottom + 8 + 6;
    const stageTop = top + headerHeight;
    return {
      header: { x: left, y: top, width: width - left - right, height: headerHeight },
      stage: { x: left + STAGE_GAP, y: stageTop, width: width - left - right - 2 * STAGE_GAP, height: height - stageTop - (bottom + 8 + dockHeight + 14) - 8 },
      dock: { x: left, y: height - dockBottom - dockHeight, width: width - left - right, height: dockHeight },
    };
  }
  if (arrangement === "landscape") {
    const dockHeight = 52;
    return {
      header: { x: left, y: 8, width: width - left - right, height: 44 },
      stage: { x: left + STAGE_GAP, y: 8, width: width - left - right - 2 * STAGE_GAP, height: height - 8 - bottom - 4 },
      dock: { x: left, y: height - (bottom + 6) - dockHeight, width: width - left - right, height: dockHeight },
    };
  }
  const stageTop = top + 60;
  return {
    header: { x: 0, y: top, width, height: 60 },
    stage: { x: 16, y: stageTop, width: width - 32 - (cardOpen ? 352 : 0), height: height - stageTop - (bottom + 16 + 44 + 16) },
    dock: { x: 0, y: height - (bottom + 16) - 44, width, height: 44 },
  };
}
