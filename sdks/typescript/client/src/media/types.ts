import type { V1MediaPublication, V1MediaSource } from "../sync/v1-types";

export type CloudflareSFUBootstrap = {
  readonly connectionId: string;
  readonly stunServer: string;
};

export type CloudflareSFUSessionDescription = {
  readonly type: "offer" | "answer";
  readonly sdp: string;
};

export type CloudflareSFUTrackRequest = {
  readonly location: "local" | "remote";
  readonly mid?: string;
  readonly trackName: string;
  readonly sessionId?: string;
  readonly source?: V1MediaSource;
  readonly publicationId?: string;
};

export type CloudflareSFUCloseTrackRequest = {
  readonly mid: string;
  readonly source: V1MediaSource;
  readonly publicationId: string;
};

export type CloudflareSFUTracksResponse = {
  readonly sessionDescription?: CloudflareSFUSessionDescription;
  readonly tracks?: readonly CloudflareSFUTrackRequest[];
  readonly requiresImmediateRenegotiation?: boolean;
};

export type CloudflareSFUPublication = {
  readonly participantSessionId: string;
  readonly source: V1MediaSource;
  readonly publicationId: string;
};

export type CloudflareSFUPublicationSnapshot = {
  readonly incarnation: number;
  readonly sequence: number;
  readonly publications: readonly CloudflareSFUPublication[];
};

export type CloudflareSFUSignalingTransport = {
  readonly addTracks: (input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUTrackRequest[] }) => Promise<CloudflareSFUTracksResponse>;
  readonly closeTracks: (input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUCloseTrackRequest[]; readonly force: boolean }) => Promise<CloudflareSFUTracksResponse>;
  readonly renegotiate: (input: { readonly connectionId: string; readonly sessionDescription: CloudflareSFUSessionDescription }) => Promise<void>;
  readonly listPublications: () => Promise<CloudflareSFUPublicationSnapshot>;
};

export type CloudflareSFURemoteTrack = CloudflareSFUPublication & {
  readonly track: MediaStreamTrack;
};

export type CloudflareSFULocalTrack = Pick<V1MediaPublication, "source" | "enabled" | "publicationId"> & {
  readonly track: MediaStreamTrack;
};

export type CloudflareSFUErrorCode = "invalid_bootstrap" | "invalid_publication" | "invalid_target" | "signaling_failed" | "media_failed" | "peer_connection_failed" | "ice_connection_failed" | "stale_generation";

export type CloudflareSFUFailureCode = CloudflareSFUErrorCode;

export type CloudflareSFUConnectionPhase = "idle" | "connecting" | "live" | "recovering" | "failed" | "stopped";

export type CloudflareSFUPhase = CloudflareSFUConnectionPhase;

export type CloudflareSFUSnapshot = {
  readonly connection: {
    readonly phase: CloudflareSFUConnectionPhase;
    readonly peerConnectionState: RTCPeerConnectionState | null;
    readonly iceConnectionState: RTCIceConnectionState | null;
  };
  readonly cursor: { readonly incarnation: number; readonly sequence: number } | null;
  readonly localTracks: readonly CloudflareSFULocalTrack[];
  readonly remoteTracks: readonly CloudflareSFURemoteTrack[];
  readonly failure: { readonly code: CloudflareSFUFailureCode; readonly recoverable: boolean } | null;
};

export type CloudflareSFUClientOptions = {
  readonly bootstrap: CloudflareSFUBootstrap;
  readonly participantSessionId: string;
  readonly transport: CloudflareSFUSignalingTransport;
  readonly pollIntervalMs?: number;
  readonly onError?: (error: unknown) => void;
  readonly onRemoteTrack?: (publication: CloudflareSFURemoteTrack) => void;
  readonly onScreenEnded?: () => void;
  readonly peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
};

export type CloudflareSFURestartOptions = {
  readonly bootstrap: CloudflareSFUBootstrap;
  readonly transport?: CloudflareSFUSignalingTransport;
};

export type CloudflareSFUCredentialProvider = () => string | Promise<string>;

export type CloudflareSFUHTTPTransportOptions = {
  readonly apiBaseURL: string;
  readonly credential?: CloudflareSFUCredentialProvider;
  /** @deprecated Use credential so refreshed media access is read before every request. */
  readonly bearerToken?: string;
  readonly tenantId: string;
  /** Canonical Space/Episode/Participant route identifiers. */
  readonly spaceId?: string;
  readonly episodeId?: string;
  readonly participantId?: string;
  /** @deprecated Use spaceId, episodeId, and participantId. */
  readonly roomId?: string;
  /** @deprecated Use episodeId. */
  readonly sessionId?: string;
  /** @deprecated Use participantId. */
  readonly participantSessionId?: string;
  readonly fetch?: typeof globalThis.fetch;
};

export class CloudflareSFUError extends Error {
  constructor(
    message: string,
    readonly code: CloudflareSFUFailureCode,
  ) {
    super(message);
    this.name = "CloudflareSFUError";
  }
}
