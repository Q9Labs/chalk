import type { TelemetrySink } from "../telemetry/types";
import type { TransportDiagnostic } from "../transport-diagnostics";
import type { MediaConnectionReplacementCause, MediaPublication, MediaPublicationSource } from "./plane";
export type SFUIceServer = {
  readonly urls: readonly string[];
  readonly username?: string;
  readonly credential?: string;
};
export type SFUBootstrap = {
  readonly connectionId: string;
  readonly iceServers: readonly SFUIceServer[];
  readonly capabilities?: SFUMediaCapabilities;
};

/** Capabilities advertised by the SFU for this connection. */
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
  /** A connection nobody has used yet stays valid until the SFU reports it gone, so the client does not swap it before its first offer. */
  readonly keepsIdleSession: boolean;
  /** The https origin of the direct door that serves the signalling calls; the Tunnel serves them when it is absent or fails. */
  readonly directSignalingUrl?: string;
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
export type SFUSessionDescription = {
  readonly type: "offer" | "answer";
  readonly sdp: string;
};
export type SFUTrackRequest = {
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
export type SFUCloseTrackRequest = {
  readonly mid: string;
  readonly source: MediaPublicationSource;
  readonly publicationId: string;
};
export type SFUTracksResponse = {
  readonly sessionDescription?: SFUSessionDescription;
  readonly tracks?: readonly SFUTrackRequest[];
  readonly trackErrors?: readonly {
    readonly connectionId: string;
    readonly trackName: string;
    readonly code: string;
  }[];
  readonly requiresImmediateRenegotiation?: boolean;
};
export type SFUPublication = {
  readonly participantId: string;
  readonly source: MediaPublicationSource;
  readonly publicationId: string;
  /** The owner muted it in place: it stays listed and subscribed, and sends nothing until it resumes. */
  readonly paused?: boolean;
};
export type SFUPublicationSnapshot = {
  readonly incarnation: number;
  readonly sequence: number;
  readonly publications: readonly SFUPublication[];
};
export type SFUSignalingTransport = {
  readonly addTracks: (input: { readonly connectionId: string; readonly sessionDescription?: SFUSessionDescription; readonly tracks: readonly SFUTrackRequest[]; readonly allowPartialRemoteTracks?: boolean; readonly replacementCause?: MediaConnectionReplacementCause }) => Promise<SFUTracksResponse>;
  readonly closeTracks: (input: { readonly connectionId: string; readonly sessionDescription?: SFUSessionDescription; readonly tracks: readonly SFUCloseTrackRequest[]; readonly force: boolean; readonly receiveOnly?: boolean }) => Promise<SFUTracksResponse>;
  /** Changes the simulcast layer of tracks already pulled, or pauses them in place, without renegotiating. Transports without it keep the layer chosen at pull time. */
  readonly updateTracks?: (input: { readonly connectionId: string; readonly tracks: readonly SFUTrackRequest[] }) => Promise<SFUTracksResponse>;
  readonly renegotiate: (input: { readonly connectionId: string; readonly sessionDescription: SFUSessionDescription }) => Promise<void>;
  readonly listPublications: () => Promise<SFUPublicationSnapshot>;
  /**
   * One request that lists the publications and pulls the other Participants' microphone and screen audio.
   * The response carries the SFU's offer for those tracks, which the caller must answer with `renegotiate`.
   * Only a plane with the `pullPublished` capability answers it.
   */
  readonly pullPublishedAudio?: (input: { readonly connectionId: string }) => Promise<{ readonly snapshot: SFUPublicationSnapshot; readonly response: SFUTracksResponse }>;
  /** Reads the delivery state of this connection's remote videos. Only a plane with `subscriptionState` answers it. */
  readonly listSubscriptions?: () => Promise<readonly SFUSubscriptionState[]>;
  /**
   * Best-effort per-call stats upload; transports without it simply report nothing. The `closing`
   * batch reuses the last token and never asks the credential provider, which could refresh access
   * for a participant who just left or was evicted.
   */
};
export type SFURemoteTrack = SFUPublication & {
  readonly track: MediaStreamTrack;
};
export type SFULocalTrack = Pick<MediaPublication, "source" | "enabled" | "publicationId"> & {
  readonly track: MediaStreamTrack;
};
export type SFUErrorCode = "invalid_bootstrap" | "invalid_publication" | "invalid_target" | "signaling_failed" | "signaling_timeout" | "negotiation_timeout" | "media_failed" | "peer_connection_failed" | "ice_connection_failed" | "stale_generation";
export type SFUFailureCode = SFUErrorCode;
export type SFUConnectionPhase = "idle" | "connecting" | "live" | "recovering" | "failed" | "stopped";
export type SFUPhase = SFUConnectionPhase;
export type SFUSnapshot = {
  /** Omitted by media adapters without receive diagnostics; treat as empty. */
  readonly receiveStalls?: readonly import("./receive-stall").ReceiveStallObservation[];
  /** Remote videos whose delivery the SFU reported. Omitted or empty on planes without `subscriptionState`. */
  readonly remoteDelivery?: readonly import("./subscription-delivery").RemoteVideoDelivery[];
  /** The latest call-stats windows, oldest first, for the call menu's charts. Omitted by planes that do not measure the connection. */
  readonly callStats?: readonly import("./call-stats").CallStatsSample[];
  readonly connection: {
    readonly phase: SFUConnectionPhase;
    readonly peerConnectionState: RTCPeerConnectionState | null;
    readonly iceConnectionState: RTCIceConnectionState | null;
  };
  readonly cursor: {
    readonly incarnation: number;
    readonly sequence: number;
  } | null;
  readonly localTracks: readonly SFULocalTrack[];
  readonly remoteTracks: readonly SFURemoteTrack[];
  readonly failure: {
    readonly code: SFUFailureCode;
    readonly recoverable: boolean;
    readonly diagnostic?: import("./failure-diagnostics").MediaFailureDiagnostic;
  } | null;
};
/** A local SDP offer was still pending when it should not be. `origin` names the SDK call that started it. */
export type SFULocalOfferDiagnostic = {
  readonly event: "local_offer_pending";
  readonly where: "sdp_operation_start" | "remote_offer";
  readonly origin: "publish" | "publish_without_simulcast" | "close" | "ice_restart" | "receive_transport" | "outside_sdk";
  readonly pendingMs: number | null;
};
export type SFUClientOptions = {
  readonly bootstrap: SFUBootstrap;
  readonly participantId: string;
  readonly transport: SFUSignalingTransport;
  /** Asks for a fresh connection. The argument is the connection this client runs on, so a replacement made since then is not replaced again. */
  readonly replaceMediaConnection?: (observedConnectionId: string) => Promise<SFUBootstrap>;
  readonly pollIntervalMs?: number;
  /**
   * How long an unreported video publication waits for `setVideoTileVisibility` before it is pulled. Defaults to 250 ms;
   * a UI that never reports tiles can pass 0 to pull every video at once.
   */
  readonly unreportedVideoTileWaitMs?: number;
  /** False on a WebRTC implementation whose camera encoder cannot send simulcast; the camera then publishes one full-size stream. */
  readonly cameraSimulcast?: boolean;
  readonly onError?: (error: unknown, mediaConnectionId: string) => void;
  readonly onDiagnostic?: (event: SFULocalOfferDiagnostic) => void;
  readonly onRemoteTrack?: (publication: SFURemoteTrack) => void;
  readonly onReceiveHealth?: (event: TransportDiagnostic) => void;
  /** Where call stats windows go. */
  readonly telemetry?: TelemetrySink;
  readonly onScreenEnded?: () => void;
  readonly peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
};
export type SFURestartOptions = {
  readonly bootstrap: SFUBootstrap;
  readonly transport?: SFUSignalingTransport;
};
export type SFUCredentialProvider = (signal?: AbortSignal) => string | Promise<string>;
export type SFUHTTPTransportOptions = {
  readonly traceparent?: string;
  readonly onDiagnostic?: (event: TransportDiagnostic) => void;
  readonly apiBaseURL: string;
  readonly credential?: SFUCredentialProvider;
  /**
   * Fetches a fresh grant for the current media connection and returns its token. The transport calls it once when the API answers 403 and
   * sends the request again with the new token; a second 403 is final.
   */
  readonly refreshCredential?: SFUCredentialProvider;
  /** @deprecated Use credential so refreshed media access is read before every request. */
  readonly bearerToken?: string;
  readonly tenantId: string;
  /** Canonical Space/Episode/Participant route identifiers. */
  readonly spaceId: string;
  readonly episodeId: string;
  readonly participantId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  /**
   * The https origin of the direct door, from the grant. A probe of it starts with the transport; signalling goes there while it
   * answers and replays on `apiBaseURL` when a call cannot reach the API through it. Absent: every call uses `apiBaseURL`.
   */
  readonly directBaseURL?: string;
  /** Shared failure memory for the direct door; defaults to the one Sync uses. */
  readonly directMemory?: import("../direct-path").DirectPathMemory;
  /** Told when the path that carries signalling changes, and on the first call. */
  readonly onPath?: (path: import("../direct-path").TransportPath) => void;
};
export class SFUError extends Error {
  constructor(
    message: string,
    readonly code: SFUFailureCode,
    readonly options: {
      readonly status?: number;
      readonly retryableConnection?: boolean;
      readonly providerCode?: string;
      /** The ICE state observed when a peer-connection wait expired. */
      readonly iceConnectionState?: RTCIceConnectionState;
    } = {},
  ) {
    super(message);
    this.name = "SFUError";
  }
}
