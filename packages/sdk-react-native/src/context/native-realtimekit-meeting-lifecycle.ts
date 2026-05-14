interface ResolveNativeRealtimeKitMeetingArgs<TMeeting> {
  currentMeeting: TMeeting | null;
  nextMeeting: TMeeting | null;
  reason: "connected" | "disconnected";
}

export function resolveNativeRealtimeKitMeeting<TMeeting>({ currentMeeting, nextMeeting, reason }: ResolveNativeRealtimeKitMeetingArgs<TMeeting>): TMeeting | null {
  if (reason === "disconnected") {
    // Preserve the last RTK provider value through disconnect-driven teardown so
    // NativeVideoConference can keep its local end-state UI instead of remounting
    // back to the lobby shell mid-leave.
    return currentMeeting;
  }

  return nextMeeting;
}
