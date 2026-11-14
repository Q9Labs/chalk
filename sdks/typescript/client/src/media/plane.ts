import type { operations } from "../generated/openapi-types";

export type MediaConnectionReplacementCause = NonNullable<NonNullable<operations["addCloudflareSFUTracks"]["parameters"]["query"]>["replacement_cause"]>;
/** Why the SDK closes tracks, sent with every close so the API can explain it. */
export type MediaCloseReason = "user_mute" | "unpublish" | "replacement" | "leave" | "error";
export function closeReasonOf(cause: LocalPublicationRetirementCause): MediaCloseReason {
  switch (cause) {
    case "user_pause":
      return "user_mute";
    case "moderation_pause":
    case "forced_pause":
    case "capture_cleanup":
    case "consent_revoked":
    case "discovery_absent":
      return "unpublish";
    case "sync_recovery_loss":
    case "publish_failure":
    case "enable_failure":
    case "projection_mismatch":
      return "error";
  }
}
export type LocalPublicationRetirementCause = Exclude<MediaConnectionReplacementCause, "local_signaling_failure" | "remote_signaling_failure" | "dormant_connection" | "access_refresh" | "receive_stalled" | "section_budget">;

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
  /** Remote videos whose delivery the SFU reported. Omitted or empty on planes without `subscriptionState`. */
  readonly remoteDelivery?: readonly import("./subscription-delivery").RemoteVideoDelivery[];
  /** The latest call-stats windows, oldest first, for the call menu's charts. Omitted by planes that do not measure the connection. */
  readonly callStats?: readonly import("./call-stats").CallStatsSample[];
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
  /**
   * Runs the part of an enable that needs no grant, while Sync still decides it. It never creates a
   * publication: `setLocalPublicationTarget` stays the only step that publishes, and it redoes whatever
   * this left undone. A rejection is safe to ignore for that reason. A plane that parks a muted track
   * on its server (mute in place) may resume that track here. The server's source lease authorizes what it
   * forwards, and a role change, a removal and the end of the Episode revoke it. A listener must never get
   * audio the authority would refuse, so the track may forward under a standing lease for about one round
   * trip, until Sync's first result: the caller then runs `cancelPreparedLocalPublicationTarget` unless it
   * goes on to `setLocalPublicationTarget`.
   */
  readonly prepareLocalPublicationTarget?: (target: MediaPlaneTarget) => Promise<void>;
  /**
   * Undoes what `prepareLocalPublicationTarget` resumed ahead of the grant. The caller runs it, without waiting
   * for the head start, when the target will not be executed (a refusal, a retryable refusal, a timeout, a
   * disconnect). The plane silences the track locally at once, then parks the publication again the way a user
   * mute parks it, once any resume request has settled (also an unanswered one). It does nothing when nothing
   * was resumed ahead or `setLocalPublicationTarget` has taken it over.
   */
  readonly cancelPreparedLocalPublicationTarget?: (target: MediaPlaneTarget) => Promise<void>;
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
  readonly localPublicationWithdrawn?: (publicationId: string) => void;
};
