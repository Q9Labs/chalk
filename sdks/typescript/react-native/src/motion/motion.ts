import { ReduceMotion, useReducedMotion, withTiming, type WithTimingConfig } from "react-native-reanimated";
import { durations, easings } from "../theme/tokens";

export { useReducedMotion };

/**
 * Named timings from the mockup. Each one also honours the system's reduced-motion setting,
 * which makes the change instant.
 */
export const timings = {
  press: { duration: durations.press, easing: easings.easeOut, reduceMotion: ReduceMotion.System },
  fade: { duration: durations.chromeFade, easing: easings.easeOut, reduceMotion: ReduceMotion.System },
  menu: { duration: durations.menu, easing: easings.emphasized, reduceMotion: ReduceMotion.System },
  toastIn: { duration: durations.toastIn, easing: easings.emphasized, reduceMotion: ReduceMotion.System },
  toastOut: { duration: durations.toastOut, easing: easings.easeOut, reduceMotion: ReduceMotion.System },
  scrim: { duration: durations.scrim, easing: easings.easeOut, reduceMotion: ReduceMotion.System },
  sheet: { duration: durations.sheet, easing: easings.emphasized, reduceMotion: ReduceMotion.System },
  move: { duration: durations.move, easing: easings.move, reduceMotion: ReduceMotion.System },
  enter: { duration: durations.enter, easing: easings.move, reduceMotion: ReduceMotion.System },
  leave: { duration: durations.leave, easing: easings.easeOut, reduceMotion: ReduceMotion.System },
  copyMorph: { duration: durations.copyMorph, easing: easings.emphasized, reduceMotion: ReduceMotion.System },
  switch: { duration: durations.press, easing: easings.easeOut, reduceMotion: ReduceMotion.System },
  avatarTurn: { duration: durations.avatarTurn, easing: easings.standard, reduceMotion: ReduceMotion.System },
  level: { duration: durations.speakingLevel, easing: easings.linear, reduceMotion: ReduceMotion.System },
} as const satisfies Readonly<Record<string, WithTimingConfig>>;

export type TimingName = keyof typeof timings;

/** `withTiming` with one of the named timings. Call it from a worklet or from JS. */
export function animateTo(value: number, timing: TimingName): number {
  "worklet";
  return withTiming(value, timings[timing]);
}
