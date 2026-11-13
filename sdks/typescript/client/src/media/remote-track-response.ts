import { parseCloudflareSFUPublicationID, publicationKey } from "./tracks";
import { CloudflareSFUError, type CloudflareSFUPublication, type CloudflareSFURemoteTrack, type CloudflareSFUTrackRequest } from "./types";

export function matchRemotePullTracks(publications: readonly CloudflareSFUPublication[], tracks: readonly CloudflareSFUTrackRequest[]) {
  const requested = new Map(
    publications.map((publication) => {
      const reference = parseCloudflareSFUPublicationID(publication.publicationId);
      return [`${reference.connectionId}\u0000${reference.trackName}`, publication] as const;
    }),
  );
  const mids = new Set<string>();
  return tracks.map(({ location, sessionId: connectionId, trackName, mid }) => {
    const key = `${connectionId}\u0000${trackName}` as const;
    const publication = requested.get(key);
    if (location !== "remote" || !publication || !mid || mids.has(mid)) throw new CloudflareSFUError("Cloudflare SFU returned an invalid remote track identity", "invalid_publication");
    requested.delete(key);
    mids.add(mid);
    return { publication, mid };
  });
}

export function desiredRemotePublications(publications: readonly CloudflareSFUPublication[], participantId: string): Map<string, CloudflareSFUPublication> {
  return new Map(publications.filter((publication) => publication.participantId !== participantId).map((publication) => [publicationKey(publication), publication]));
}
export function reconcileRemoteTracks(desired: ReadonlyMap<string, CloudflareSFUPublication>, pulled: readonly CloudflareSFURemoteTrack[], current: ReadonlyMap<string, CloudflareSFURemoteTrack>): Map<string, CloudflareSFURemoteTrack> {
  const pulledByKey = new Map(pulled.map((publication) => [publicationKey(publication), publication]));
  return new Map(
    [...desired].flatMap(([key, publication]) => {
      const track = pulledByKey.get(key) ?? current.get(key);
      if (!track || track.publicationId !== publication.publicationId) return [];
      return [[key, track] as const];
    }),
  );
}
// A remote track is never stopped: a stopped track stays ended for good, and the SFU reuses the mid of a closed one.
export function droppedRemoteTracks(current: ReadonlyMap<string, CloudflareSFURemoteTrack>, next: ReadonlyMap<string, CloudflareSFURemoteTrack>): readonly CloudflareSFURemoteTrack[] {
  // The SFU can put a re-pull on the receiver it just closed, so the new publication keeps the old track. That receiver is live again.
  const kept = new Set([...next.values()].map((publication) => publication.track));
  return [...current].filter(([key, previous]) => next.get(key) !== previous && !kept.has(previous.track)).map(([, previous]) => previous);
}
export function* chunks<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let index = 0; index < items.length; index += size) yield items.slice(index, index + size);
}
