// The Chalk SFU's quotas and the client's own timing policy, in one place.
//
// Provider limits the client is written against:
//   - a request names at most TRACKS_PER_REQUEST tracks (16), or the SFU rejects it;
//   - the media node refuses offers over 262144 bytes (OFFER_SIZE_LIMIT_BYTES);
//   - each participant gets 60 call-control writes per minute, and viewer adaptation
//     budgets at most 12 of them (VIEWER_LAYER_UPDATE_INTERVAL_MS pacing);
//   - the SFU answers 404, 406 or 410 once it has dropped a session, and expires
//     tracks after 30 seconds without RTP (CAPTURE_REUSE_WINDOW_MS stays under it).
import type { MediaPublicationSource } from "./plane";
import type { SFULocalTrack, SFUPublication, SFURemoteTrack, SFUMediaCapabilities } from "./types";

export const CONNECTION_TIMEOUT_MS = 8000;
// Each participant may spend 60 call-control writes per minute; viewer-layer adaptation budgets at most 12.
export const CALL_CONTROL_WRITES_PER_MINUTE = 60;
export const ADAPTATION_WRITE_BUDGET_PER_MINUTE = 12;
export const NEGOTIATION_TIMEOUT_MS = 35000;
export const PEER_OPERATION_TIMEOUT_MS = 8000;
// The SFU rejects a request of more than 16 tracks.
export const TRACKS_PER_REQUEST = 16;
export const LONG_PULL_DEFERRAL_MS = 15_000;
export const TRANSIENT_PULL_RETRY_MS = [500, 1000, 2000];
// A failed remote pull backs off exponentially from 750ms, counted at most 6 times.
export const REMOTE_PULL_BACKOFF_BASE_MS = 750;
export const REMOTE_PULL_BACKOFF_CAP_MS = 15_000;
export const REMOTE_PULL_BACKOFF_LIMIT = 6;
// A failed poll retries promptly at first, then returns toward the idle cadence.
export const POLL_RETRY_BASE_MS = 500;
export const POLL_RETRY_JITTER_MS = 500;
export const POLL_FAILURE_LIMIT = 6;
// A sender's Sync off can reach a receiver before the sender's SFU close does, so the first listing still names the source.
// The listing then needs a quick re-read, not the idle poll, to drop the track the viewer sees as a frozen tile.
export const SYNC_OFF_REPOLL_MS = [150, 300, 600, 1200, 2400, 4800] as const;
export const RECEIVER_RETIREMENT_ATTEMPTS = 3;
export const RECEIVER_RETIREMENT_LIMIT = 64;
// The media node reuses closed sections, so the offer should never grow this far.
export const OFFER_SIZE_LIMIT_BYTES = 262144;
export const OFFER_REPLACEMENT_COOLDOWN_MS = 60_000;
export const RECOVERY_BACKOFF_MS = [1000, 2000, 4000, 5000] as const;
export const RECOVERY_HEALTHY_RESET_MS = 10_000;
// A publish rejected on a connection that is not up replaces it at most this many times, after these delays.
export const DEAD_CONNECTION_REPLACEMENT_DELAYS_MS = [0, 1000] as const;
// Statuses that require a new session rather than retrying the same one.
export const DEAD_SESSION_STATUSES: ReadonlySet<number | undefined> = new Set([404, 406, 410]);
// An in-place ICE restart must reconnect within this budget, or the session is replaced.
export const ICE_RESTART_BUDGET_MS = 8000;
// A path that stays disconnected this long restarts ICE before the browser declares it failed.
export const ICE_DISCONNECTED_RESTART_MS = 2000;
export const ICE_RESTART_FAILURE = Object.freeze({ code: "ice_connection_failed", recoverable: true } as const);
export const VIEWER_LAYER_BATCH_SIZE = 16;
// Adaptation uses at most 12 of the participant's 60 call-control writes/minute.
export const VIEWER_LAYER_UPDATE_INTERVAL_MS = 5000;
// Bound reuse for SFU nodes that do not advertise durable idle sessions.
export const CAPTURE_REUSE_WINDOW_MS = 20_000;
export const NO_CAPABILITIES: SFUMediaCapabilities = Object.freeze({ serverLayerAdaptation: false, subscriptionState: false, iceRestart: false, pullPublished: false, unifiedSignaling: false, muteInPlace: false, keepsIdleSession: false });
export const INVALID_PUBLICATION_SIGNATURE = "\u0000invalid";
export const EMPTY_LOCAL: readonly SFULocalTrack[] = Object.freeze([]);
export const EMPTY_REMOTE: readonly SFURemoteTrack[] = Object.freeze([]);
export type RemoteTrackEntry = readonly [string, SFURemoteTrack];

/** A pull retry waits this long: 750ms doubling each counted failure, capped. */
export function remotePullBackoffMs(failures: number, capMs = REMOTE_PULL_BACKOFF_CAP_MS): number {
  return Math.min(capMs, REMOTE_PULL_BACKOFF_BASE_MS * 2 ** (failures - 1));
}
/** A failed poll waits a jittered exponential backoff toward the idle interval. */
export function pollFailureDelayMs(failures: number, intervalMs: number): number {
  return Math.min(intervalMs, (POLL_RETRY_BASE_MS + Math.random() * POLL_RETRY_JITTER_MS) * 2 ** (failures - 1));
}
export function isVideoPublication(publication: Pick<SFUPublication, "source">): boolean {
  return publication.source === "camera" || publication.source === "screen";
}
export function localSourceGroup(source: MediaPublicationSource): readonly MediaPublicationSource[] {
  return source === "screen" ? [source, "screen_audio"] : [source];
}
export function recoveryBackoffMs(attempt: number): number {
  return RECOVERY_BACKOFF_MS[Math.min(attempt, RECOVERY_BACKOFF_MS.length - 1)]!;
}
