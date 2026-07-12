import type { MeetingTransitionReason, ResolveMeetingInput } from "../media-plane-port";

export function resolveMeeting<TMeeting>({ currentMeeting, nextMeeting, reason }: ResolveMeetingInput<TMeeting>): TMeeting | undefined {
  if (reason === "disconnected") {
    // Preserve the provider through disconnect teardown so end-state UI does not
    // remount into the lobby shell before the session transition finishes.
    return currentMeeting;
  }

  return nextMeeting;
}

export type { MeetingTransitionReason };
