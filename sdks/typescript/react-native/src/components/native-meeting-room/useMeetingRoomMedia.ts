import type { UseMediaReturn } from "../../hooks/useMedia";
import type { UseScreenShareReturn } from "../../hooks/useScreenShare";
import type { MeetingRoomActionRunner } from "./types";

export interface MeetingRoomMedia {
  readonly isMuted: boolean;
  readonly isCameraOff: boolean;
  readonly toggleAudio: () => void;
  readonly toggleVideo: () => void;
  readonly toggleScreenShare: () => void;
}

interface UseMeetingRoomMediaOptions {
  readonly media: Pick<UseMediaReturn, "isAudioEnabled" | "isVideoEnabled" | "toggleAudio" | "toggleVideo">;
  readonly screenShare: Pick<UseScreenShareReturn, "toggle">;
  readonly run: MeetingRoomActionRunner;
}

export function useMeetingRoomMedia({ media, screenShare, run }: UseMeetingRoomMediaOptions): MeetingRoomMedia {
  return {
    isMuted: !media.isAudioEnabled,
    isCameraOff: !media.isVideoEnabled,
    toggleAudio: () => void run(media.toggleAudio),
    toggleVideo: () => void run(media.toggleVideo),
    toggleScreenShare: () => void run(screenShare.toggle),
  };
}
