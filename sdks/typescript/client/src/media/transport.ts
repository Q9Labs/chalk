import type { MediaPublicationSource } from "./plane";
import { markMediaFailure, markMediaFetchFailure } from "./failure-diagnostics";
import type { MediaFailureStep } from "./failure-diagnostics";
import { CloudflareSFUError } from "./types";
import type { CloudflareSFUCredentialProvider, CloudflareSFUHTTPTransportOptions, CloudflareSFUPublicationSnapshot, CloudflareSFUSignalingTransport, CloudflareSFUTracksResponse, SFUSubscriptionState } from "./types";
import { withRequestContext } from "../session";
import type { CallStatsRequest } from "./call-stats";
const SIGNALING_TIMEOUT_MS = 8000;
const CREDENTIAL_TIMEOUT_MS = 7000;
const CREDENTIAL_MEASURE = "chalk.sfu.credential";
/** One SFU signaling call. The per-operation routes carry it in the URL; the unified `signal` route carries it in the body. */
type SignalOp = "publications" | "subscriptions" | "tracks" | "tracks_close" | "tracks_update" | "renegotiate";
const LEGACY_ROUTES: Readonly<Record<SignalOp, { readonly method: "GET" | "POST" | "PUT"; readonly path: string }>> = {
  publications: { method: "GET", path: "publications" },
  subscriptions: { method: "GET", path: "subscriptions" },
  tracks: { method: "POST", path: "tracks" },
  tracks_close: { method: "PUT", path: "tracks/close" },
  tracks_update: { method: "PUT", path: "tracks/update" },
  renegotiate: { method: "POST", path: "renegotiate" },
};
const SIGNALING_STEPS: Readonly<Record<SignalOp, MediaFailureStep>> = {
  publications: "sfu_publications",
  subscriptions: "sfu_subscriptions",
  tracks: "sfu_tracks",
  tracks_close: "sfu_close_tracks",
  tracks_update: "sfu_tracks",
  renegotiate: "sfu_renegotiate",
};
export function createCloudflareSFUHTTPTransport(options: CloudflareSFUHTTPTransportOptions): CloudflareSFUSignalingTransport {
  const fetch = withRequestContext(options.fetch);
  const credential = requireCredential(options);
  let lastToken = "";
  const base = options.apiBaseURL.replace(/\/$/, "");
  const mediaPath = `${base}/v1/tenants/${encodeURIComponent(options.tenantId)}/spaces/${encodeURIComponent(options.spaceId)}/episodes/${encodeURIComponent(options.episodeId)}/participants/${encodeURIComponent(options.participantId)}/media/sfu`;
  const statsPath = `${base}/v1/tenants/${encodeURIComponent(options.tenantId)}/call-stats`;
  const timeoutMs = options.requestTimeoutMs ?? SIGNALING_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CloudflareSFUError("The signaling deadline is invalid", "signaling_failed");
  const freshToken = async (op?: SignalOp): Promise<string> => {
    const startedAt = performance.now();
    try {
      const token = await withDeadline(CREDENTIAL_TIMEOUT_MS, (signal) => credential(signal));
      if (!token.trim()) throw new CloudflareSFUError("The media credential provider returned an empty token", "signaling_failed");
      lastToken = token;
      return token;
    } finally {
      if (op) traceCredentialRead(op, startedAt);
    }
  };
  /**
   * Sends one signaling call. `query` holds the options the per-operation tracks route reads from its query string;
   * the unified route reads them from the body. The unified route is used only when the API advertised it for this connection.
   */
  const request = async <T>(op: SignalOp, body?: Readonly<Record<string, unknown>>, query: Readonly<Record<string, string | true>> = {}): Promise<T> => {
    try {
      const token = await freshToken(op);
      const route = LEGACY_ROUTES[op];
      const target = options.unifiedSignaling
        ? { url: `${mediaPath}/signal`, method: "POST", body: JSON.stringify({ op, ...unifiedBody(op, body), ...query }) }
        : { url: `${mediaPath}/${route.path}${Object.keys(query).length ? `?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}` : ""}`, method: route.method, body: body && JSON.stringify(body) };
      return await withDeadline(timeoutMs, async (signal) => {
        const startedAt = performance.now();
        const response = await fetch(target.url, {
          method: target.method,
          ...(target.body === undefined ? {} : { body: target.body }),
          signal,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.traceparent ? { traceparent: options.traceparent } : {}) },
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
      markMediaFailure(error, SIGNALING_STEPS[op]);
      throw error;
    }
  };
  return {
    addTracks: async (input) => {
      const response = await request<{
        readonly sessionDescription?: CloudflareSFUTracksResponse["sessionDescription"];
        readonly tracks?: readonly (Omit<NonNullable<CloudflareSFUTracksResponse["tracks"]>[number], "publicationId"> & {
          readonly publication_id?: string;
        })[];
        readonly requiresImmediateRenegotiation?: boolean;
      }>(
        "tracks",
        { connection_id: input.connectionId, session_description: input.sessionDescription, tracks: input.tracks },
        { ...(input.allowPartialRemoteTracks ? { allow_partial_remote_tracks: true as const } : {}), ...(input.replacementCause ? { replacement_cause: input.replacementCause } : {}) },
      );
      return {
        ...response,
        tracks: response.tracks?.map(({ publication_id, ...track }) => ({ ...track, publicationId: publication_id })),
      };
    },
    closeTracks: async (input) =>
      request<CloudflareSFUTracksResponse>("tracks_close", {
        connection_id: input.connectionId,
        session_description: input.sessionDescription,
        tracks: input.tracks.map((track) => ({ mid: track.mid, source: track.source, publication_id: track.publicationId })),
        force: input.force,
        ...(input.receiveOnly ? { receive_only: true } : {}),
      }),
    updateTracks: async (input) => request<CloudflareSFUTracksResponse>("tracks_update", { connection_id: input.connectionId, tracks: input.tracks }),
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
      await request("renegotiate", { connection_id: input.connectionId, session_description: input.sessionDescription });
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
    listPublications: async (): Promise<CloudflareSFUPublicationSnapshot> => {
      const response = await request<{
        incarnation: number;
        sequence: number;
        publications: readonly {
          participant_id?: string;
          participant_session_id?: string;
          source: MediaPublicationSource;
          publication_id: string;
        }[];
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
/** The unified route names the close list `close_tracks`, because `tracks` there is the list of tracks to add or update. */
function unifiedBody(op: SignalOp, body: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  if (op !== "tracks_close" || !body) return body;
  const { tracks, ...rest } = body;
  return { ...rest, close_tracks: tracks };
}
/** Marks the time spent inside the credential provider as a user-timing entry, so a latency run can show whether it waits on a network round trip. */
function traceCredentialRead(op: SignalOp, startedAt: number): void {
  try {
    performance.measure(CREDENTIAL_MEASURE, { start: startedAt, end: performance.now(), detail: { op } });
  } catch {
    /* Observers cannot interrupt signaling. */
  }
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
