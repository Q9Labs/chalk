import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import type { VideoConferenceDiagnosticsSnapshot, VideoConferencePhase } from "../components/VideoConference";
import type { MeetingRoomDiagnosticsSnapshot } from "../components/native-meeting-room/diagnostics";

export type VideoConferenceDiagnosticsOptions = {
  readonly session: Pick<ChalkSessionStore, "subscribe" | "getSnapshot">;
  readonly phase: VideoConferencePhase;
  readonly roomId: string;
  readonly roomName?: string;
  readonly joinError: string | null;
  readonly meetingRoom: MeetingRoomDiagnosticsSnapshot | null;
  readonly onChange?: (snapshot: VideoConferenceDiagnosticsSnapshot) => void;
};

export function useVideoConferenceDiagnostics(options: VideoConferenceDiagnosticsOptions): void {
  const subscribe = useCallback((listener: () => void) => options.session.subscribe(listener), [options.session]);
  const getSnapshot = useCallback(() => options.session.getSnapshot(), [options.session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    options.onChange?.({
      phase: options.phase,
      roomId: options.roomId,
      roomName: options.roomName || options.roomId,
      lastJoinError: options.joinError,
      connectionStatus: snapshot.state,
      isConnected: snapshot.state === "live",
      isJoining: snapshot.state === "joining",
      session: { state: snapshot.state, failure: snapshot.failure },
      meetingRoom: options.meetingRoom,
    });
  }, [options.joinError, options.meetingRoom, options.onChange, options.phase, options.roomId, options.roomName, snapshot.failure, snapshot.state]);
}
