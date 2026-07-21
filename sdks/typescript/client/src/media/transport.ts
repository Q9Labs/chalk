import type { V3MediaSource } from "../sync/v3-types";
import { CloudflareSFUError } from "./types";
import type { CloudflareSFUCredentialProvider, CloudflareSFUHTTPTransportOptions, CloudflareSFUPublicationSnapshot, CloudflareSFUSignalingTransport, CloudflareSFUTracksResponse } from "./types";

export function createCloudflareSFUHTTPTransport(options: CloudflareSFUHTTPTransportOptions): CloudflareSFUSignalingTransport {
  const fetch = options.fetch ?? globalThis.fetch;
  const credential = requireCredential(options);
  const base = options.apiBaseURL.replace(/\/$/, "");
  const mediaPath = `${base}/v1/tenants/${encodeURIComponent(options.tenantId)}/rooms/${encodeURIComponent(options.roomId)}/sessions/${encodeURIComponent(options.sessionId)}/participants/${encodeURIComponent(options.participantSessionId)}/media/sfu`;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const token = await credential();
    if (!token.trim()) throw new CloudflareSFUError("The media credential provider returned an empty token", "signaling_failed");
    const response = await fetch(`${mediaPath}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
    });
    if (!response.ok) throw new CloudflareSFUError(`Chalk SFU signaling failed with HTTP ${response.status}`, "signaling_failed");
    return (await response.json()) as T;
  };
  return {
    addTracks: async (input) => {
      const response = await request<{
        readonly sessionDescription?: CloudflareSFUTracksResponse["sessionDescription"];
        readonly tracks?: readonly (Omit<NonNullable<CloudflareSFUTracksResponse["tracks"]>[number], "publicationId"> & { readonly publication_id?: string })[];
        readonly requiresImmediateRenegotiation?: boolean;
      }>("tracks", {
        method: "POST",
        body: JSON.stringify({ connection_id: input.connectionId, session_description: input.sessionDescription, tracks: input.tracks }),
      });
      return {
        ...response,
        tracks: response.tracks?.map(({ publication_id, ...track }) => ({ ...track, publicationId: publication_id })),
      };
    },
    closeTracks: async (input) =>
      request<CloudflareSFUTracksResponse>("tracks/close", {
        method: "PUT",
        body: JSON.stringify({
          connection_id: input.connectionId,
          tracks: input.tracks.map((track) => ({ mid: track.mid, source: track.source, publication_id: track.publicationId })),
        }),
      }),
    renegotiate: async (input) => {
      await request("renegotiate", {
        method: "POST",
        body: JSON.stringify({ connection_id: input.connectionId, session_description: input.sessionDescription }),
      });
    },
    listPublications: async (): Promise<CloudflareSFUPublicationSnapshot> => {
      const response = await request<{
        incarnation: number;
        sequence: number;
        publications: readonly { participant_session_id: string; source: V3MediaSource; publication_id: string }[];
      }>("publications");
      return {
        incarnation: response.incarnation,
        sequence: response.sequence,
        publications: response.publications.map((publication) => ({
          participantSessionId: publication.participant_session_id,
          source: publication.source,
          publicationId: publication.publication_id,
        })),
      };
    },
  };
}

function requireCredential(options: CloudflareSFUHTTPTransportOptions): CloudflareSFUCredentialProvider {
  if (options.credential) return options.credential;
  if (options.bearerToken !== undefined) return () => options.bearerToken ?? "";
  throw new CloudflareSFUError("A media credential provider is required", "signaling_failed");
}
