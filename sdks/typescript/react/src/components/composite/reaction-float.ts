import type { CSSProperties } from "react";

/** How many horizontal lanes reactions rise in, spread across the left part of the stage. */
export const REACTION_LANES = 6;
const LANE_START_PERCENT = 6;
const LANE_STEP_PERCENT = 5;
const MIN_TRAVEL_PX = 240;
const TRAVEL_SPREAD_PX = 120;
const MAX_SWAY_PX = 14;
/** Small stable hash so a reaction keeps its lane across re-renders without storing state. */
export function hashReactionId(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash;
}

/** Position a reaction directly from recording-relative time, with no CSS clock. */
export function reactionPresentationStyle(eventId: string, progress: number): CSSProperties {
  const hash = hashReactionId(eventId);
  const lane = hash % REACTION_LANES;
  const travel = MIN_TRAVEL_PX + ((hash >>> 3) % (TRAVEL_SPREAD_PX + 1));
  const sway = ((hash >>> 7) % (MAX_SWAY_PX * 2 + 1)) - MAX_SWAY_PX;
  const clamped = Math.max(0, Math.min(1, progress));
  const opacity = clamped < 0.12 ? clamped / 0.12 : clamped > 0.72 ? (1 - clamped) / 0.28 : 1;
  return {
    left: `${LANE_START_PERCENT + lane * LANE_STEP_PERCENT}%`,
    bottom: `${96 + travel * clamped}px`,
    opacity: Math.max(0, Math.min(1, opacity)),
    transform: `translateX(${Math.sin(clamped * Math.PI) * sway}px)`,
  };
}
