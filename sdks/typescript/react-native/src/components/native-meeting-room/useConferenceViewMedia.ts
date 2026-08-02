import type { UseMediaReturn } from "../../hooks/useMedia";
import type { UseScreenShareReturn } from "../../hooks/useScreenShare";
import type { ConferenceViewActionRunner } from "./types";

export interface ConferenceViewMedia {
  readonly isMuted: boolean;
  readonly isCameraOff: boolean;
  readonly toggleAudio: () => void;
  readonly toggleVideo: () => void;
  readonly toggleScreenShare: () => void;
}

interface UseConferenceViewMediaOptions {
  readonly media: Pick<UseMediaReturn, "isAudioEnabled" | "isVideoEnabled" | "toggleAudio" | "toggleVideo">;
  readonly screenShare: Pick<UseScreenShareReturn, "toggle">;
  readonly run: ConferenceViewActionRunner;
}

export function useConferenceViewMedia({ media, screenShare, run }: UseConferenceViewMediaOptions): ConferenceViewMedia {
  return {
    isMuted: !media.isAudioEnabled,
    isCameraOff: !media.isVideoEnabled,
    toggleAudio: () => void run(media.toggleAudio),
    toggleVideo: () => void run(media.toggleVideo),
    toggleScreenShare: () => void run(screenShare.toggle),
  };
}
