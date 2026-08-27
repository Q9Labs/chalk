export type MediaSource = "microphone" | "camera" | "screen";

export type MediaPublication = {
  readonly participantId: string;
  readonly source: MediaSource;
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
  readonly connection: {
    readonly phase: ConnectionMediaPhase;
    readonly peerConnectionState: RTCPeerConnectionState | null;
    readonly iceConnectionState: RTCIceConnectionState | null;
  };
  readonly cursor: { readonly incarnation: number; readonly sequence: number } | null;
  readonly localTracks: readonly ConnectionMediaLocalTrack[];
  readonly remoteTracks: readonly ConnectionMediaRemoteTrack[];
  readonly failure: { readonly code: string; readonly recoverable: boolean } | null;
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
  readonly setLocalPublicationTarget: (target: MediaPlaneTarget) => Promise<MediaPlaneResult>;
  readonly observeLocalPublications: (listener: (publications: readonly MediaPublication[]) => void) => () => void;
  readonly observeRemotePublications: (listener: (publications: readonly MediaPublication[]) => void) => () => void;
};
