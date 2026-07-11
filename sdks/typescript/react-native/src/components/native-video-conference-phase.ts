import type { NativeVideoConferencePhase } from "./NativeVideoConference";

interface ResolveInitialNativeVideoConferencePhaseArgs {
  initialPhase?: NativeVideoConferencePhase;
  autoJoin?: boolean;
  isConnected: boolean;
  activeRoomId: string | null;
  roomId: string;
}

export function shouldResumeNativeMeetingPhase({ isConnected, activeRoomId, roomId }: Pick<ResolveInitialNativeVideoConferencePhaseArgs, "isConnected" | "activeRoomId" | "roomId">): boolean {
  return isConnected && activeRoomId === roomId;
}

export function resolveInitialNativeVideoConferencePhase({ initialPhase, autoJoin = false, isConnected, activeRoomId, roomId }: ResolveInitialNativeVideoConferencePhaseArgs): NativeVideoConferencePhase {
  if (shouldResumeNativeMeetingPhase({ isConnected, activeRoomId, roomId })) {
    return "meeting";
  }

  return initialPhase ?? (autoJoin ? "joining" : "lobby");
}
