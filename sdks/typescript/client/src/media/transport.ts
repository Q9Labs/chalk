import type { MediaPublicationSource } from "./plane";
import { markMediaFailure, markMediaFetchFailure } from "./failure-diagnostics";
import type { MediaFailureStep } from "./failure-diagnostics";
import { CloudflareSFUError } from "./types";
import type { CloudflareSFUCredentialProvider, CloudflareSFUHTTPTransportOptions, CloudflareSFUPublicationSnapshot, CloudflareSFUSignalingTransport, CloudflareSFUTracksResponse, SFUSubscriptionState } from "./types";
import { withRequestContext } from "../session";
import type { CallStatsRequest } from "./call-stats";
const SIGNALING_TIMEOUT_MS = 8000;
const CREDENTIAL_TIMEOUT_MS = 7000;
const SIGNALING_STEPS: Readonly<Partial<Record<string, MediaFailureStep>>> = { publications: "sfu_publications", subscriptions: "sfu_subscriptions", "tracks/close": "sfu_close_tracks", renegotiate: "sfu_renegotiate" };
export function createCloudflareSFUHTTPTransport(options: CloudflareSFUHTTPTransportOptions): CloudflareSFUSignalingTransport {
  const fetch = withRequestContext(options.fetch);
  const credential = requireCredential(options);
  let lastToken = "";
  const base = options.apiBaseURL.replace(/\/$/, "");
  const mediaPath = `${base}/v1/tenants/${encodeURIComponent(options.tenantId)}/spaces/${encodeURIComponent(options.spaceId)}/episodes/${encodeURIComponent(options.episodeId)}/participants/${encodeURIComponent(options.participantId)}/media/sfu`;
  const statsPath = `${base}/v1/tenants/${encodeURIComponent(options.tenantId)}/call-stats`;
  const timeoutMs = options.requestTimeoutMs ?? SIGNALING_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CloudflareSFUError("The signaling deadline is invalid", "signaling_failed");
  const freshToken = async (): Promise<string> => {
    const token = await withDeadline(CREDENTIAL_TIMEOUT_MS, (signal) => credential(signal));
    if (!token.trim()) throw new CloudflareSFUError("The media credential provider returned an empty token", "signaling_failed");
    lastToken = token;
    return token;
  };
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    try {
      const token = await freshToken();
      return await withDeadline(timeoutMs, async (signal) => {
        const startedAt = performance.now();
        const response = await fetch(`${mediaPath}/${path}`, {
          ...init,
          signal,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.traceparent ? { traceparent: options.traceparent } : {}), ...init?.headers },
        }).catch((error: unknown) => {
          markMediaFetchFailure(error);
          throw error;
        });
        if (!response.ok) {
          try {
            options.onDiagnostic?.({ event: "media_http_error", http_status: response.status, duration_ms: performance.now() - startedAt });
          } catch {
            /* Observers cannot interrupt signaling. */
          }
          throw new CloudflareSFUError(`Chalk SFU signaling failed with HTTP ${response.status}`, "signaling_failed", {
            status: response.status,
            retryableConnection: response.status === 404 || response.status === 410 || (response.status >= 500 && response.status < 600),
          });
        }
        return (await response.json()) as T;
      });
    } catch (error) {
      const step = SIGNALING_STEPS[path] ?? "sfu_tracks";
      markMediaFailure(error, step);
      throw error;
    }
  };
  return {
    addTracks: async (input) => {
      const query = new URLSearchParams();
      if (input.allowPartialRemoteTracks) query.set("allow_partial_remote_tracks", "true");
      if (input.replacementCause) query.set("replacement_cause", input.replacementCause);
      const path = query.size ? `tracks?${query}` : "tracks";
      const response = await request<TracksWireResponse>(path, {
        method: "POST",
        body: JSON.stringify({ connection_id: input.connectionId, session_description: input.sessionDescription, tracks: input.tracks }),
      });
      return tracksResponse(response);
    },
    closeTracks: async (input) =>
      request<CloudflareSFUTracksResponse>("tracks/close", {
        method: "PUT",
        body: JSON.stringify({
          connection_id: input.connectionId,
          session_description: input.sessionDescription,
          tracks: input.tracks.map((track) => ({ mid: track.mid, source: track.source, publication_id: track.publicationId })),
          force: input.force,
          ...(input.receiveOnly ? { receive_only: true } : {}),
        }),
      }),
    updateTracks: async (input) =>
      request<CloudflareSFUTracksResponse>("tracks/update", {
        method: "PUT",
        body: JSON.stringify({ connection_id: input.connectionId, tracks: input.tracks }),
      }),
    listSubscriptions: async (): Promise<readonly SFUSubscriptionState[]> => {
      const response = await request<{
        subscriptions: readonly {
          mid: string;
          session_id: string;
          track_name: string;
          state: SFUSubscriptionState["state"];
          reason?: SFUSubscriptionState["reason"];
          revision: number;
          requested_rid?: string;
          effective_rid?: string;
        }[];
      }>("subscriptions");
      return response.subscriptions.map((subscription) => ({
        mid: subscription.mid,
        sessionId: subscription.session_id,
        trackName: subscription.track_name,
        state: subscription.state,
        revision: subscription.revision,
        ...(subscription.reason ? { reason: subscription.reason } : {}),
        ...(subscription.requested_rid ? { requestedRid: subscription.requested_rid } : {}),
        ...(subscription.effective_rid ? { effectiveRid: subscription.effective_rid } : {}),
      }));
    },
    renegotiate: async (input) => {
      await request("renegotiate", {
        method: "POST",
        body: JSON.stringify({ connection_id: input.connectionId, session_description: input.sessionDescription }),
      });
    },
    uploadCallStats: async (stats: CallStatsRequest, closing: boolean) => {
      // A hidden tab stops signaling, so the cached token can expire during a call. Only the closing batch skips the provider.
      const token = closing ? lastToken : await freshToken();
      if (!token) return;
      await withDeadline(timeoutMs, async (signal) => {
        const response = await fetch(statsPath, {
          method: "POST",
          signal,
          keepalive: true,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(stats),
        });
        if (!response.ok) throw new CloudflareSFUError(`Chalk call stats upload failed with HTTP ${response.status}`, "signaling_failed", { status: response.status });
      });
    },
    listPublications: async (): Promise<CloudflareSFUPublicationSnapshot> => publicationSnapshot(await request<WirePublicationList>("publications")),
    pullPublishedAudio: async (input) => {
      const { publications, ...response } = await request<TracksWireResponse & { readonly publications?: WirePublicationList }>("tracks?allow_partial_remote_tracks=true", {
        method: "POST",
        body: JSON.stringify({ connection_id: input.connectionId, tracks: [], pull_published_audio: true }),
      });
      if (!publications) throw new CloudflareSFUError("The pull-published response carried no publications", "signaling_failed");
      return { snapshot: publicationSnapshot(publications), response: tracksResponse(response) };
    },
  };
}
type TracksWireResponse = {
  readonly sessionDescription?: CloudflareSFUTracksResponse["sessionDescription"];
  readonly tracks?: readonly (Omit<NonNullable<CloudflareSFUTracksResponse["tracks"]>[number], "publicationId"> & {
    readonly publication_id?: string;
  })[];
  readonly requiresImmediateRenegotiation?: boolean;
};
type WirePublicationList = {
  readonly incarnation: number;
  readonly sequence: number;
  readonly publications: readonly {
    readonly participant_id?: string;
    readonly participant_session_id?: string;
    readonly source: MediaPublicationSource;
    readonly publication_id: string;
  }[];
};
function tracksResponse(response: TracksWireResponse): CloudflareSFUTracksResponse {
  return { ...response, tracks: response.tracks?.map(({ publication_id, ...track }) => ({ ...track, publicationId: publication_id })) };
}
function publicationSnapshot(response: WirePublicationList): CloudflareSFUPublicationSnapshot {
  return {
    incarnation: response.incarnation,
    sequence: response.sequence,
    publications: response.publications.map((publication) => ({
      participantId: publication.participant_id ?? publication.participant_session_id ?? "",
      source: publication.source,
      publicationId: publication.publication_id,
    })),
  };
}
async function withDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = new CloudflareSFUError("Cloudflare SFU signaling timed out. Try again.", "signaling_timeout");
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      controller.abort();
      reject(timeout);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]);
  } catch (error) {
    if (controller.signal.aborted) throw timeout;
    throw error;
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}
function requireCredential(options: CloudflareSFUHTTPTransportOptions): CloudflareSFUCredentialProvider {
  if (options.credential) return options.credential;
  if (options.bearerToken !== undefined) return () => options.bearerToken ?? "";
  throw new CloudflareSFUError("A media credential provider is required", "signaling_failed");
}
