import type { SFULocalTrack, SFURemoteTrack, SFUSnapshot } from "./types";

const EMPTY_RECEIVE_STALLS = Object.freeze([]);
export function freezeSnapshot(snapshot: SFUSnapshot): SFUSnapshot {
  const failure = snapshot.failure ? Object.freeze(snapshot.failure) : null;
  return Object.freeze({
    ...snapshot,
    connection: Object.freeze(snapshot.connection),
    cursor: snapshot.cursor ? Object.freeze(snapshot.cursor) : null,
    localTracks: Object.freeze(snapshot.localTracks),
    remoteTracks: Object.freeze(snapshot.remoteTracks),
    failure,
  });
}
export function snapshotEqual(left: SFUSnapshot, right: SFUSnapshot): boolean {
  return snapshotMetadataEqual(left, right) && left.localTracks.every((publication, index) => publicationEqual(publication, right.localTracks[index])) && left.remoteTracks.every((publication, index) => remotePublicationEqual(publication, right.remoteTracks[index]));
}
function snapshotMetadataEqual(left: SFUSnapshot, right: SFUSnapshot): boolean {
  return (
    (left.receiveStalls ?? EMPTY_RECEIVE_STALLS) === (right.receiveStalls ?? EMPTY_RECEIVE_STALLS) &&
    sharedRefsEqual(left, right) &&
    connectionEqual(left.connection, right.connection) &&
    cursorEqual(left.cursor, right.cursor) &&
    failureEqual(left.failure, right.failure) &&
    left.localTracks.length === right.localTracks.length &&
    left.remoteTracks.length === right.remoteTracks.length
  );
}
function sharedRefsEqual(left: SFUSnapshot, right: SFUSnapshot): boolean {
  return left.remoteDelivery === right.remoteDelivery && left.callStats === right.callStats;
}
function connectionEqual(left: SFUSnapshot["connection"], right: SFUSnapshot["connection"]): boolean {
  return left.phase === right.phase && left.peerConnectionState === right.peerConnectionState && left.iceConnectionState === right.iceConnectionState;
}
function cursorEqual(left: SFUSnapshot["cursor"], right: SFUSnapshot["cursor"]): boolean {
  return left?.incarnation === right?.incarnation && left?.sequence === right?.sequence;
}
function failureEqual(left: SFUSnapshot["failure"], right: SFUSnapshot["failure"]): boolean {
  return left?.code === right?.code && left?.recoverable === right?.recoverable;
}
function publicationEqual(left: SFULocalTrack, right: SFULocalTrack | undefined): boolean {
  return right !== undefined && left.source === right.source && left.enabled === right.enabled && left.publicationId === right.publicationId && left.track === right.track;
}
function remotePublicationEqual(left: SFURemoteTrack, right: SFURemoteTrack | undefined): boolean {
  return right !== undefined && left.participantId === right.participantId && left.source === right.source && left.publicationId === right.publicationId && left.track === right.track;
}
