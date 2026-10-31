import type { operations } from "../generated/openapi-types";

export type MediaConnectionReplacementCause = NonNullable<NonNullable<operations["addCloudflareSFUTracks"]["parameters"]["query"]>["replacement_cause"]>;
export type LocalPublicationRetirementCause = Exclude<MediaConnectionReplacementCause, "local_signaling_failure" | "remote_signaling_failure" | "dormant_connection" | "access_refresh" | "receive_stalled">;

export type ScreenShareSurface = "monitor" | "window" | "browser";
export type ScreenShareOptions = {
  readonly surface?: ScreenShareSurface;
  readonly audio?: boolean;
};
export type ScreenShareCapture = {
  readonly surface: ScreenShareSurface | null;
  readonly label: string | null;
};
export type MediaSource = "microphone" | "camera" | "screen";

export type MediaPublicationSource = MediaSource | "screen_audio";

export type MediaPublication = {
  readonly participantId: string;
  readonly source: MediaPublicationSource;
  readonly enabled: boolean;
  readonly publicationId: string | null;
};

export type ConnectionMediaPhase = "idle" | "connecting" | "live" | "recovering" | "failed" | "stopped";

export type ConnectionMediaLocalTrack = Pick<MediaPublication, "source" | "enabled" | "publicationId"> & {
  readonly track: MediaStreamTrack;
};

export type ConnectionMediaRemoteTrack = Pick<MediaPublication, "participantId" | "source"> & {
  readonly publicationId: string;
  readonly track: MediaStreamTrack;
};

export type ConnectionMediaSnapshot = {
  readonly receiveStalls?: readonly import("./receive-stall").ReceiveStallObservation[];
  readonly connection: {
    readonly phase: ConnectionMediaPhase;
    readonly peerConnectionState: RTCPeerConnectionState | null;
    readonly iceConnectionState: RTCIceConnectionState | null;
  };
  readonly cursor: { readonly incarnation: number; readonly sequence: number } | null;
  readonly localTracks: readonly ConnectionMediaLocalTrack[];
  readonly remoteTracks: readonly ConnectionMediaRemoteTrack[];
  readonly failure: { readonly code: string; readonly recoverable: boolean; readonly diagnostic?: import("./failure-diagnostics").MediaFailureDiagnostic } | null;
};

export type MediaPlaneOutcome = "confirmed" | "satisfied" | "retryable_failure" | "terminal_failure" | "ambiguous";

export type MediaPlaneTarget = {
  readonly operationId: string;
  readonly participantId: string;
  readonly source: MediaSource;
  readonly enabled: boolean;
};

export type MediaPlaneResult = {
  readonly outcome: MediaPlaneOutcome;
  readonly errorCode: string | null;
};

export type ClientMediaPlane = {
  readonly observeAudioElement?: (track: MediaStreamTrack, element: HTMLAudioElement) => { played(result: unknown): void; detach(): void };
  readonly setLocalPublicationTarget: (target: MediaPlaneTarget) => Promise<MediaPlaneResult>;
  readonly pauseLocalCapture?: (source: "microphone" | "camera") => Promise<void>;
  readonly setLocalSourceIntent?: (source: MediaSource, enabled: boolean, cause?: LocalPublicationRetirementCause) => void;
  readonly closeForcedLocalPublication?: (source: MediaSource, cause?: LocalPublicationRetirementCause) => Promise<void>;
  readonly observeLocalPublications: (listener: (publications: readonly MediaPublication[]) => void) => () => void;
  readonly observeRemotePublications: (listener: (publications: readonly MediaPublication[]) => void) => () => void;
  /** Unavailable suspends receive eligibility without withdrawing publication identities. */
  readonly remotePublicationsChanged?: (publications?: readonly MediaPublication[], projectionState?: "available" | "unavailable") => void;
  readonly remoteParticipantsChanged?: (participantIds: readonly string[]) => void;
  readonly remotePublicationResumed?: (publicationId: string) => void;
};
