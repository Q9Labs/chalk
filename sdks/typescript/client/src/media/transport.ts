import type { MediaSource } from "./plane";
import { CloudflareSFUError } from "./types";
import type { CloudflareSFUCredentialProvider, CloudflareSFUHTTPTransportOptions, CloudflareSFUPublicationSnapshot, CloudflareSFUSignalingTransport, CloudflareSFUTracksResponse } from "./types";

const SIGNALING_TIMEOUT_MS = 8_000;

export function createCloudflareSFUHTTPTransport(options: CloudflareSFUHTTPTransportOptions): CloudflareSFUSignalingTransport {
  const fetch = options.fetch ?? globalThis.fetch;
  const credential = requireCredential(options);
  const base = options.apiBaseURL.replace(/\/$/, "");
  const mediaPath = `${base}/v1/tenants/${encodeURIComponent(options.tenantId)}/spaces/${encodeURIComponent(options.spaceId)}/episodes/${encodeURIComponent(options.episodeId)}/participants/${encodeURIComponent(options.participantId)}/media/sfu`;
  const timeoutMs = options.requestTimeoutMs ?? SIGNALING_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CloudflareSFUError("The signaling deadline is invalid", "signaling_failed");
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const controller = new AbortController();
    const timeout = new CloudflareSFUError("Cloudflare SFU signaling timed out. Try again.", "signaling_timeout");
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => {
        controller.abort();
        reject(timeout);
      }, timeoutMs);
    });
    const operation = async (): Promise<T> => {
      const token = await credential();
      if (controller.signal.aborted) throw timeout;
      if (!token.trim()) throw new CloudflareSFUError("The media credential provider returned an empty token", "signaling_failed");
      const response = await fetch(`${mediaPath}/${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
      });
      if (!response.ok) {
        throw new CloudflareSFUError(`Chalk SFU signaling failed with HTTP ${response.status}`, "signaling_failed", {
          status: response.status,
          retryableConnection: response.status === 404 || response.status === 410 || (response.status >= 500 && response.status < 600),
        });
      }
      return (await response.json()) as T;
    };
    try {
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (controller.signal.aborted) throw timeout;
      throw error;
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  };
  return {
    addTracks: async (input) => {
      const path = input.allowPartialRemoteTracks ? "tracks?allow_partial_remote_tracks=true" : "tracks";
      const response = await request<{
        readonly sessionDescription?: CloudflareSFUTracksResponse["sessionDescription"];
        readonly tracks?: readonly (Omit<NonNullable<CloudflareSFUTracksResponse["tracks"]>[number], "publicationId"> & { readonly publication_id?: string })[];
        readonly requiresImmediateRenegotiation?: boolean;
      }>(path, {
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
          session_description: input.sessionDescription,
          tracks: input.tracks.map((track) => ({ mid: track.mid, source: track.source, publication_id: track.publicationId })),
          force: input.force,
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
        publications: readonly { participant_id?: string; participant_session_id?: string; source: MediaSource; publication_id: string }[];
      }>("publications");
      return {
        incarnation: response.incarnation,
        sequence: response.sequence,
        publications: response.publications.map((publication) => ({
          participantId: publication.participant_id ?? publication.participant_session_id ?? "",
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
