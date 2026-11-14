import { requireDescription } from "./tracks";
import { CloudflareSFUError, type CloudflareSFUSnapshot } from "./types";

export function connectionIsLive(connection: RTCPeerConnection): boolean {
  return connection.connectionState === "connected" && (connection.iceConnectionState === "connected" || connection.iceConnectionState === "completed");
}
export function connectionIsClosed(connection: RTCPeerConnection): boolean {
  return connection.connectionState === "closed";
}
// The MIDs of the sections an offer turns on: a section the SFU sends on, not one it keeps recvonly or inactive.
export function activeOfferedMids(offerSDP: string): ReadonlySet<string> {
  const mids = new Set<string>();
  for (const section of offerSDP.split(/\r?\n(?=m=)/)) {
    const mid = /\r?\na=mid:(\S+)/.exec(section)?.[1];
    if (mid !== undefined && !/\r?\na=(?:recvonly|inactive)\b/.test(section)) mids.add(mid);
  }
  return mids;
}
// The MID of the m-section that owns the BUNDLE transport: the first one in the group of the last local description.
export function bundleTagOf(connection: RTCPeerConnection): string | undefined {
  return /(?:^|\r?\n)a=group:BUNDLE[ \t]+(\S+)/.exec(connection.localDescription?.sdp ?? "")?.[1];
}
export function requireTransceiverMid(transceiver: RTCRtpTransceiver): string {
  if (transceiver.mid === null) throw new CloudflareSFUError("Browser did not assign a media section", "media_failed");
  return transceiver.mid;
}
export function safeStopTrack(track: MediaStreamTrack, onError: (error: unknown) => void): void {
  try {
    track.stop();
  } catch (error) {
    onError(error);
  }
}
export function safeStopTransceiver(transceiver: RTCRtpTransceiver, onError: (error: unknown) => void): void {
  // On React Native a stopped transceiver is gone natively, so a second stop() rejects with "Could not get transceiver" and nothing can catch it.
  if (transceiver.direction === "stopped" || transceiver.currentDirection === "stopped") return;
  try {
    transceiver.stop();
  } catch (error) {
    onError(error);
  }
}
export async function createLocalOffer(connection: RTCPeerConnection, options?: RTCOfferOptions) {
  const offer = await connection.createOffer(options);
  await connection.setLocalDescription(offer);
  return requireDescription(offer);
}
export function observeConnectionState(
  peerState: RTCPeerConnectionState,
  iceState: RTCIceConnectionState,
  started: boolean,
):
  | (Pick<CloudflareSFUSnapshot, "failure"> & {
      readonly phase: CloudflareSFUSnapshot["connection"]["phase"];
    })
  | null {
  if (peerState === "failed") return { phase: "failed", failure: { code: "peer_connection_failed", recoverable: true } };
  if (iceState === "failed") return { phase: "failed", failure: { code: "ice_connection_failed", recoverable: true } };
  if (peerState === "disconnected" || iceState === "disconnected") return { phase: "recovering", failure: null };
  if (started && peerState === "connected" && (iceState === "connected" || iceState === "completed")) return { phase: "live", failure: null };
  return null;
}
export function pictureInPictureTracks(): readonly MediaStreamTrack[] {
  if (typeof document === "undefined" || typeof HTMLVideoElement === "undefined" || typeof MediaStream === "undefined") return [];
  const video = document.pictureInPictureElement;
  return video instanceof HTMLVideoElement && video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks() : [];
}
export function pageIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}
// Picture-in-picture events bubble from the video element to the document.
export const PAGE_VISIBILITY_EVENTS = ["visibilitychange", "enterpictureinpicture", "leavepictureinpicture"] as const;
export function firefoxCameraSimulcastUnsupported(): boolean {
  // Firefox accepts RID encodings but can pause 720p h on an unthrottled link.
  // Capabilities do not expose that allocation policy. Preserve the single-
  // camera path for Gecko Firefox; FxiOS uses WebKit and is not matched.
  return typeof navigator !== "undefined" && /\bFirefox\/\d+/i.test(navigator.userAgent);
}

/** Settles like `operation`, or rejects with `expired()` once `ms` pass. `expired` runs when the timer fires, so it can record the expiry. */
export function withDeadline<T>(operation: Promise<T>, ms: number, expired: () => Error): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => reject(expired()), ms);
  });
  return Promise.race([operation, deadline]).finally(() => globalThis.clearTimeout(timer));
}

/** The transceiver whose receiver carries `track`. */
export function transceiverOf(connection: RTCPeerConnection, track: MediaStreamTrack): RTCRtpTransceiver | undefined {
  return connection.getTransceivers().find((item) => item.receiver.track === track);
}
