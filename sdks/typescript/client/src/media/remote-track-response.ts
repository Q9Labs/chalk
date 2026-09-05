import { parseCloudflareSFUPublicationID } from "./tracks";
import { CloudflareSFUError, type CloudflareSFUPublication, type CloudflareSFUTrackRequest } from "./types";

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
