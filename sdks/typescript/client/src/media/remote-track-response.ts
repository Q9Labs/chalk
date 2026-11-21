import { parseSFUPublicationID, publicationKey } from "./tracks";
import { SFUError, type SFUPublication, type SFURemoteTrack, type SFUTrackRequest } from "./types";

export function trackKey(connectionId: string | undefined, trackName: string): string {
  return `${connectionId}\u0000${trackName}`;
}

/** Publications keyed by the SFU session and track name a pull request or its errors name. */
export function publicationsByTrack(publications: readonly SFUPublication[]): Map<string, SFUPublication> {
  return new Map(
    publications.map((publication) => {
      const reference = parseSFUPublicationID(publication.publicationId);
      return [trackKey(reference.connectionId, reference.trackName), publication] as const;
    }),
  );
}

export function matchRemotePullTracks(publications: readonly SFUPublication[], tracks: readonly SFUTrackRequest[]) {
  const requested = publicationsByTrack(publications);
  const mids = new Set<string>();
  return tracks.map(({ location, sessionId: connectionId, trackName, mid }) => {
    const key = trackKey(connectionId, trackName);
    const publication = requested.get(key);
    if (location !== "remote" || !publication || !mid || mids.has(mid)) throw new SFUError("Chalk SFU returned an invalid remote track identity", "invalid_publication");
    requested.delete(key);
    mids.add(mid);
    return { publication, mid };
  });
}

export function desiredRemotePublications(publications: readonly SFUPublication[], participantId: string): Map<string, SFUPublication> {
  return new Map(publications.filter((publication) => publication.participantId !== participantId).map((publication) => [publicationKey(publication), publication]));
}
export function reconcileRemoteTracks(desired: ReadonlyMap<string, SFUPublication>, pulled: readonly SFURemoteTrack[], current: ReadonlyMap<string, SFURemoteTrack>): Map<string, SFURemoteTrack> {
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
export function droppedRemoteTracks(current: ReadonlyMap<string, SFURemoteTrack>, next: ReadonlyMap<string, SFURemoteTrack>): readonly SFURemoteTrack[] {
  // The SFU can put a re-pull on the receiver it just closed, so the new publication keeps the old track. That receiver is live again.
  const kept = new Set([...next.values()].map((publication) => publication.track));
  return [...current].filter(([key, previous]) => next.get(key) !== previous && !kept.has(previous.track)).map(([, previous]) => previous);
}
export function* chunks<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let index = 0; index < items.length; index += size) yield items.slice(index, index + size);
}
