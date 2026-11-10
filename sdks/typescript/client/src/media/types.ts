import type { ConnectionReportTransportEvent } from "../transport-diagnostics";
import type { MediaConnectionReplacementCause, MediaPublication, MediaPublicationSource } from "./plane";
export type CloudflareSFUIceServer = {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
};
export type CloudflareSFUBootstrap =
  | {
      readonly connectionId: string;
      readonly stunServer: string;
      /** STUN and TURN servers from the API. Absent on older servers, which means STUN only. */
      readonly iceServers?: readonly CloudflareSFUIceServer[];
      readonly capabilities?: undefined;
    }
  | {
      readonly connectionId: string;
      readonly stunServer?: undefined;
      /** The own SFU sends every ICE server it wants. Empty means host candidates only. */
      readonly iceServers: readonly CloudflareSFUIceServer[];
      /** Absent means none: the client behaves as it does on Cloudflare. */
      readonly capabilities?: SFUMediaCapabilities;
    };
/** What the media plane does for this connection beyond Cloudflare's behavior. */
export type SFUMediaCapabilities = {
  /** The SFU picks each subscriber's layer under the requested one, so the client asks only for a ceiling. */
  readonly serverLayerAdaptation: boolean;
  /** The SFU reports whether it delivers each remote video, and pauses one in place on request. */
  readonly subscriptionState: boolean;
  /** The SFU answers an ICE restart offer on the existing session, so a lost path recovers without a new session. */
  readonly iceRestart: boolean;
  /** One `tracks` request lists the publications and pulls the other Participants' audio, so a join skips the list request. */
  readonly pullPublished: boolean;
  /** The API serves every signaling call from one URL, so a join pays one CORS preflight instead of one per call. */
  readonly unifiedSignaling: boolean;
  /** The SFU parks and resumes the caller's own camera or microphone in place, so a mute keeps the track and moves no SDP. */
  readonly muteInPlace: boolean;
};
/** Whether the SFU delivers one remote video of this connection. Revisions only grow for a subscription. */
export type SFUSubscriptionState = {
  readonly mid: string;
  readonly sessionId: string;
  readonly trackName: string;
  readonly state: "active" | "paused";
  /** congestion: the link cannot carry the lowest layer. viewer: this client paused it. source_inactive: the publisher sends nothing. source_unauthorized: the publisher has no live grant for it. */
  readonly reason?: "congestion" | "viewer" | "source_inactive" | "source_unauthorized";
  readonly revision: number;
  readonly requestedRid?: string;
  readonly effectiveRid?: string;
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
  readonly simulcast?: {
    readonly preferredRid: string;
    readonly priorityOrdering: "none" | "asciibetical";
    readonly ridNotAvailable: "none" | "asciibetical";
  };
  readonly source?: MediaPublicationSource;
  readonly publicationId?: string;
  /** On an update only: stops or resumes a remote video in place (a plane with `subscriptionState`), or parks or resumes the caller's own local track (a plane with `muteInPlace`). */
  readonly paused?: boolean;
};
export type CloudflareSFUCloseTrackRequest = {
  readonly mid: string;
  readonly source: MediaPublicationSource;
  readonly publicationId: string;
};
export type CloudflareSFUTracksResponse = {
  readonly sessionDescription?: CloudflareSFUSessionDescription;
  readonly tracks?: readonly CloudflareSFUTrackRequest[];
  readonly trackErrors?: readonly {
    readonly connectionId: string;
    readonly trackName: string;
    readonly code: string;
  }[];
  readonly requiresImmediateRenegotiation?: boolean;
};
export type CloudflareSFUPublication = {
  readonly participantId: string;
  readonly source: MediaPublicationSource;
  readonly publicationId: string;
};
export type CloudflareSFUPublicationSnapshot = {
  readonly incarnation: number;
  readonly sequence: number;
  readonly publications: readonly CloudflareSFUPublication[];
};
export type CloudflareSFUSignalingTransport = {
  readonly addTracks: (input: {
    readonly connectionId: string;
    readonly sessionDescription?: CloudflareSFUSessionDescription;
    readonly tracks: readonly CloudflareSFUTrackRequest[];
    readonly allowPartialRemoteTracks?: boolean;
    readonly replacementCause?: MediaConnectionReplacementCause;
  }) => Promise<CloudflareSFUTracksResponse>;
  readonly closeTracks: (input: { readonly connectionId: string; readonly sessionDescription?: CloudflareSFUSessionDescription; readonly tracks: readonly CloudflareSFUCloseTrackRequest[]; readonly force: boolean; readonly receiveOnly?: boolean }) => Promise<CloudflareSFUTracksResponse>;
  /** Changes the simulcast layer of tracks already pulled, or pauses them in place, without renegotiating. Transports without it keep the layer chosen at pull time. */
  readonly updateTracks?: (input: { readonly connectionId: string; readonly tracks: readonly CloudflareSFUTrackRequest[] }) => Promise<CloudflareSFUTracksResponse>;
  readonly renegotiate: (input: { readonly connectionId: string; readonly sessionDescription: CloudflareSFUSessionDescription }) => Promise<void>;
  readonly listPublications: () => Promise<CloudflareSFUPublicationSnapshot>;
  /**
   * One request that lists the publications and pulls the other Participants' microphone and screen audio.
   * The response carries the SFU's offer for those tracks, which the caller must answer with `renegotiate`.
   * Only a plane with the `pullPublished` capability answers it.
   */
  readonly pullPublishedAudio?: (input: { readonly connectionId: string }) => Promise<{ readonly snapshot: CloudflareSFUPublicationSnapshot; readonly response: CloudflareSFUTracksResponse }>;
  /** Reads the delivery state of this connection's remote videos. Only a plane with `subscriptionState` answers it. */
  readonly listSubscriptions?: () => Promise<readonly SFUSubscriptionState[]>;
  /**
   * Best-effort per-call stats upload; transports without it simply report nothing. The `closing`
   * batch reuses the last token and never asks the credential provider, which could refresh access
   * for a participant who just left or was evicted.
   */
  readonly uploadCallStats?: (stats: import("./call-stats").CallStatsRequest, closing: boolean) => Promise<void>;
};
export type CloudflareSFURemoteTrack = CloudflareSFUPublication & {
  readonly track: MediaStreamTrack;
};
export type CloudflareSFULocalTrack = Pick<MediaPublication, "source" | "enabled" | "publicationId"> & {
  readonly track: MediaStreamTrack;
};
export type CloudflareSFUErrorCode = "invalid_bootstrap" | "invalid_publication" | "invalid_target" | "signaling_failed" | "signaling_timeout" | "negotiation_timeout" | "media_failed" | "peer_connection_failed" | "ice_connection_failed" | "stale_generation";
export type CloudflareSFUFailureCode = CloudflareSFUErrorCode;
export type CloudflareSFUConnectionPhase = "idle" | "connecting" | "live" | "recovering" | "failed" | "stopped";
export type CloudflareSFUPhase = CloudflareSFUConnectionPhase;
export type CloudflareSFUSnapshot = {
  /** Omitted by media adapters without receive diagnostics; treat as empty. */
  readonly receiveStalls?: readonly import("./receive-stall").ReceiveStallObservation[];
  /** Remote videos whose delivery the SFU reported. Omitted or empty on planes without `subscriptionState`. */
  readonly remoteDelivery?: readonly import("./subscription-delivery").RemoteVideoDelivery[];
  /** The latest call-stats windows, oldest first, for the call menu's charts. Omitted by planes that do not measure the connection. */
  readonly callStats?: readonly import("./call-stats").CallStatsSample[];
  readonly connection: {
    readonly phase: CloudflareSFUConnectionPhase;
    readonly peerConnectionState: RTCPeerConnectionState | null;
    readonly iceConnectionState: RTCIceConnectionState | null;
  };
  readonly cursor: {
    readonly incarnation: number;
    readonly sequence: number;
  } | null;
  readonly localTracks: readonly CloudflareSFULocalTrack[];
  readonly remoteTracks: readonly CloudflareSFURemoteTrack[];
  readonly failure: {
    readonly code: CloudflareSFUFailureCode;
    readonly recoverable: boolean;
    readonly diagnostic?: import("./failure-diagnostics").MediaFailureDiagnostic;
  } | null;
};
/** A local SDP offer was still pending when it should not be. `origin` names the SDK call that started it. */
export type CloudflareSFULocalOfferDiagnostic = {
  readonly event: "local_offer_pending";
  readonly where: "sdp_operation_start" | "remote_offer";
  readonly origin: "publish" | "publish_without_simulcast" | "close" | "ice_restart" | "outside_sdk";
  readonly pendingMs: number | null;
};
export type CloudflareSFUClientOptions = {
  readonly bootstrap: CloudflareSFUBootstrap;
  readonly participantId: string;
  readonly transport: CloudflareSFUSignalingTransport;
  readonly replaceMediaConnection?: () => Promise<CloudflareSFUBootstrap>;
  readonly pollIntervalMs?: number;
  /**
   * How long an unreported video publication waits for `setVideoTileVisibility` before it is pulled. Defaults to 250 ms;
   * a UI that never reports tiles can pass 0 to pull every video at once.
   */
  readonly unreportedVideoTileWaitMs?: number;
  readonly onError?: (error: unknown, mediaConnectionId: string) => void;
  readonly onDiagnostic?: (event: CloudflareSFULocalOfferDiagnostic) => void;
  readonly onRemoteTrack?: (publication: CloudflareSFURemoteTrack) => void;
  readonly onReceiveHealth?: (event: ConnectionReportTransportEvent) => void;
  readonly onScreenEnded?: () => void;
  readonly peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
};
export type CloudflareSFURestartOptions = {
  readonly bootstrap: CloudflareSFUBootstrap;
  readonly transport?: CloudflareSFUSignalingTransport;
};
export type CloudflareSFUCredentialProvider = (signal?: AbortSignal) => string | Promise<string>;
export type CloudflareSFUHTTPTransportOptions = {
  readonly traceparent?: string;
  readonly onDiagnostic?: (event: ConnectionReportTransportEvent) => void;
  readonly apiBaseURL: string;
  readonly credential?: CloudflareSFUCredentialProvider;
  /** @deprecated Use credential so refreshed media access is read before every request. */
  readonly bearerToken?: string;
  readonly tenantId: string;
  /** Canonical Space/Episode/Participant route identifiers. */
  readonly spaceId: string;
  readonly episodeId: string;
  readonly participantId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  /** Send every signaling call to the one `signal` route. Set it only when the API advertised `unifiedSignaling` for this connection. */
  readonly unifiedSignaling?: boolean;
};
export class CloudflareSFUError extends Error {
  constructor(
    message: string,
    readonly code: CloudflareSFUFailureCode,
    readonly options: {
      readonly status?: number;
      readonly retryableConnection?: boolean;
      readonly providerCode?: string;
    } = {},
  ) {
    super(message);
    this.name = "CloudflareSFUError";
  }
}
