import type { MediaSource, ScreenShareCapture } from "../media/plane";
import type { ChalkIncomingMediaRequest } from "../collaboration/types";
import type { AudioPlaybackSlice } from "./audio-playback";

export type MediaDevice = {
  readonly deviceId: string;
  readonly label: string;
};
export type LocalMedia = {
  readonly source: MediaSource;
  readonly state: "unavailable" | "requesting" | "enabled" | "disabled" | "failed";
  readonly track: MediaStreamTrack | null;
};
export type RemoteMedia = {
  readonly participantId: string;
  readonly source: MediaSource | "screen_audio";
  readonly publicationId: string;
  readonly track: MediaStreamTrack;
  /** The SFU stopped this video because the link cannot carry its lowest layer. Audio continues, and the video returns on its own. */
  readonly pausedForNetwork?: true;
};
export type IncomingMediaRequest = ChalkIncomingMediaRequest;
export type { ScreenShareSurface, ScreenShareOptions, ScreenShareCapture } from "../media/plane";
export type MediaSlice = {
  readonly microphoneMutedByOtherDevice?: boolean;
  readonly devices: {
    readonly microphones: readonly MediaDevice[];
    readonly cameras: readonly MediaDevice[];
    readonly speakers: readonly MediaDevice[];
  };
  readonly selection: {
    readonly microphone: string | null;
    readonly camera: string | null;
    readonly speaker: string | null;
  };
  readonly local: Readonly<Record<MediaSource, LocalMedia>>;
  readonly remote: readonly RemoteMedia[];
  readonly screenShare: LocalMedia & {
    readonly hasAudio?: boolean;
    readonly capture?: ScreenShareCapture;
    /** The observed screen-video publication for this exact local track, absent during recovery or replacement. */
    readonly publicationId?: string;
  };
  readonly incomingRequests: readonly IncomingMediaRequest[];
  /** Browser playback evidence for registered remote-audio elements and AudioContexts. */
  readonly audioPlayback: AudioPlaybackSlice;
  /** The latest call-stats windows (about a minute), oldest first. Omitted until the first window closes. */
  readonly callStats?: readonly import("../media/call-stats").CallStatsSample[];
  /** How well this person's own link carries the call, steadied over several windows. Omitted before the first window closes. */
  readonly link?: import("../media/link-quality").LinkQuality;
};
