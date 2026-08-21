import type { CSSProperties } from "react";

/** How many horizontal lanes reactions rise in, spread across the left part of the stage. */
export const REACTION_LANES = 6;
const LANE_START_PERCENT = 6;
const LANE_STEP_PERCENT = 5;
const MIN_TRAVEL_PX = 240;
const TRAVEL_SPREAD_PX = 120;
const MAX_SWAY_PX = 14;
export const REACTION_RISE_MS = 3200;

export interface ReactionFloatVars extends CSSProperties {
  readonly "--reaction-travel": string;
  readonly "--reaction-sway": string;
  readonly "--reaction-duration": string;
}

/** Small stable hash so a reaction keeps its lane across re-renders without storing state. */
export function hashReactionId(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash;
}

/** Deterministic lane, travel, and sway for one reaction, keyed on its event id. */
export function reactionFloatStyle(eventId: string, durationMs = REACTION_RISE_MS): ReactionFloatVars {
  const hash = hashReactionId(eventId);
  const lane = hash % REACTION_LANES;
  const travel = MIN_TRAVEL_PX + ((hash >>> 3) % (TRAVEL_SPREAD_PX + 1));
  const sway = ((hash >>> 7) % (MAX_SWAY_PX * 2 + 1)) - MAX_SWAY_PX;
  return {
    left: `${LANE_START_PERCENT + lane * LANE_STEP_PERCENT}%`,
    "--reaction-travel": `${-travel}px`,
    "--reaction-sway": `${sway}px`,
    "--reaction-duration": `${durationMs}ms`,
  };
}
