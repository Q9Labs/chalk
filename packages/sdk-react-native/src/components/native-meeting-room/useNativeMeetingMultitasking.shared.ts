import { useMemo } from "react";
import type { ParticipantState } from "../../internal/core";
import type { NativeMeetingMultitaskingConfig } from "../../native/meeting-multitasking.android";
import type { ResolvedNativeMeetingLayout } from "../../utils/native-meeting-layout";
import { resolveNativeMeetingMultitaskingSource } from "./meeting-multitasking-source";

type RoomParticipant = ParticipantState["participants"][number];

export type NativeMeetingMultitaskingInput = {
  activeSpeaker: RoomParticipant | null;
  allParticipants: readonly RoomParticipant[];
  derived: ResolvedNativeMeetingLayout;
  isCameraOff: boolean;
  isMuted: boolean;
  localParticipant: RoomParticipant | null;
  roomName: string;
  selfName: string;
};

export function reportMultitaskingFailure(action: string, cause: unknown) {
  console.warn(`Native meeting multitasking failed during ${action}:`, cause);
}

function buildStreamURL(track: MediaStreamTrack | null): string | null {
  if (!track) {
    return null;
  }

  try {
    const { MediaStream } = require("@cloudflare/react-native-webrtc") as typeof import("@cloudflare/react-native-webrtc");
    return new MediaStream([track as never]).toURL();
  } catch {
    return null;
  }
}

export function useNativeMeetingMultitaskingConfig({ activeSpeaker, allParticipants, derived, isCameraOff, isMuted, localParticipant, roomName, selfName }: NativeMeetingMultitaskingInput): NativeMeetingMultitaskingConfig {
  const source = useMemo(
    () =>
      resolveNativeMeetingMultitaskingSource({
        activeSpeaker,
        allParticipants,
        derived,
        localParticipant,
        selfName,
      }),
    [activeSpeaker, allParticipants, derived, localParticipant, selfName],
  );
  const streamURL = useMemo(() => buildStreamURL(source.track), [source.track]);

  return useMemo(
    () => ({
      roomName,
      participantName: source.participantName,
      streamURL,
      muted: isMuted,
      cameraOff: isCameraOff,
    }),
    [isCameraOff, isMuted, roomName, source.participantName, streamURL],
  );
}
