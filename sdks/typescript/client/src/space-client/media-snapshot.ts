import { screenShareCapture } from "../connection/media-devices";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import type { ConnectionMediaSnapshot, MediaSource } from "../media";
import { structurallyEqual } from "./structural-equal";
import type { MediaSlice } from "./types";

export const MEDIA_SOURCES = ["microphone", "camera", "screen"] as const;

export function pausedPublicationIds(snapshot: ConnectionMediaSnapshot | undefined): ReadonlySet<string> {
  return new Set(snapshot?.remoteDelivery?.flatMap((delivery) => (delivery.state === "paused_for_network" ? [delivery.publicationId] : [])));
}
function liveTrack(track: MediaStreamTrack): boolean {
  return track.enabled && track.readyState === "live" && !track.muted;
}
export function livePublication(publication: ConnectionMediaSnapshot["localTracks"][number] | undefined): boolean {
  return !!publication?.enabled && liveTrack(publication.track);
}
export function confirmedLocalMediaState(track: MediaStreamTrack | null, desired: boolean, pending: boolean, confirmed: boolean, live: boolean, convergence: "requesting" | "failed" | null): MediaSlice["local"][MediaSource]["state"] {
  if (!desired) return convergence === "failed" ? "failed" : "disabled";
  if (convergence) return convergence;
  if (!live && track && liveTrack(track)) return "requesting";
  return confirmed ? "enabled" : pending ? "requesting" : "disabled";
}
export function screenLocalMedia(track: MediaStreamTrack | null, snapshot: ConnectionMediaSnapshot | undefined, connectionState: ReturnType<ConnectionLifecycleCapability["getSnapshot"]>["state"], pending: boolean): MediaSlice["local"]["screen"] {
  if (snapshot?.connection.phase === "stopped") return Object.freeze({ source: "screen", state: "unavailable", track: null });
  const publication = snapshot?.localTracks.find((candidate) => candidate.source === "screen");
  return Object.freeze({ source: "screen", state: pending ? "requesting" : screenLocalMediaState(track, publication?.enabled, connectionState), track });
}
function screenLocalMediaState(track: MediaStreamTrack | null, enabled: boolean | undefined, connectionState: ReturnType<ConnectionLifecycleCapability["getSnapshot"]>["state"]): MediaSlice["local"]["screen"]["state"] {
  if (enabled === false) {
    if (track?.enabled === false || connectionState === "live") return "disabled";
  }
  if (enabled) return "enabled";
  if (track) return "requesting";
  return connectionState === "live" || connectionState === "reconnecting" ? "disabled" : "unavailable";
}
export function confirmedScreenPublication(screen: ConnectionMediaSnapshot["localTracks"][number] | undefined, sync: ReturnType<ConnectionPorts["sync"]["getSnapshot"]> | undefined): string | undefined {
  if (!sync || !screen?.enabled || !screen.publicationId || screen.track.readyState !== "live") return undefined;
  return sync.media?.items.some((item) => item.participantId === sync.participantId && item.source === "screen" && item.enabled && item.publicationId === screen.publicationId) ? screen.publicationId : undefined;
}
export function screenShareMedia(screen: MediaSlice["local"]["screen"], snapshot: ConnectionMediaSnapshot | undefined, hasAudio: boolean, sync: ConnectionPorts["sync"] | undefined): MediaSlice["screenShare"] {
  const publicationId = publishedScreenId(screen, snapshot, sync);
  return {
    ...screen,
    hasAudio,
    ...(publicationId ? { publicationId } : {}),
    ...(screen.track ? { capture: screenShareCapture(screen.track) } : {}),
  };
}
function publishedScreenId(screen: MediaSlice["local"]["screen"], snapshot: ConnectionMediaSnapshot | undefined, sync: ConnectionPorts["sync"] | undefined): string | undefined {
  const publication = snapshot?.localTracks.find((item) => item.source === "screen" && item.track === screen.track);
  return sync && screen.state === "enabled" ? confirmedScreenPublication(publication, sync.getSnapshot()) : undefined;
}
export function sameMediaSlice(left: MediaSlice, right: MediaSlice): boolean {
  if (left.selection !== right.selection || !structurallyEqual(left.devices, right.devices)) return false;
  for (const source of MEDIA_SOURCES) if (!sameLocalMedia(left.local[source], right.local[source])) return false;
  return sameScreenShare(left.screenShare, right.screenShare) && structurallyEqual(left.remote, right.remote) && structurallyEqual(left.incomingRequests, right.incomingRequests) && left.callStats === right.callStats && sameLink(left.link, right.link);
}
function sameLink(left: MediaSlice["link"], right: MediaSlice["link"]): boolean {
  return left?.tier === right?.tier && left?.reason === right?.reason;
}
function sameScreenShare(left: MediaSlice["screenShare"], right: MediaSlice["screenShare"]): boolean {
  return sameLocalMedia(left, right) && left.hasAudio === right.hasAudio && left.publicationId === right.publicationId && left.capture?.surface === right.capture?.surface && left.capture?.label === right.capture?.label;
}
function sameLocalMedia(left: MediaSlice["local"][MediaSource], right: MediaSlice["local"][MediaSource]): boolean {
  return left.source === right.source && left.state === right.state && left.track === right.track;
}
