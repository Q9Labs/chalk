import type { MediaPublicationSource } from "./plane";
import { markMediaFailure, markMediaFetchFailure } from "./failure-diagnostics";
import type { MediaFailureStep } from "./failure-diagnostics";
import { CloudflareSFUError } from "./types";
import type { CloudflareSFUCredentialProvider, CloudflareSFUHTTPTransportOptions, CloudflareSFUPublicationSnapshot, CloudflareSFUSignalingTransport, CloudflareSFUTracksResponse, SFUSubscriptionState } from "./types";
import { DIRECT_PATH_ATTEMPT_TIMEOUT_MS, directOrigin, directPathBlocked, markDirectPathFailed, sharedDirectPathMemory } from "../direct-path";
import { withRequestContext } from "../session";
import * as apiUrls from "../api-urls";
import { trimTrailingSlashes } from "../urls";
import type { CallStatsRequest } from "./call-stats";
const SIGNALING_TIMEOUT_MS = 8000;
const CREDENTIAL_TIMEOUT_MS = 7000;
/** One SFU signaling call. The per-operation routes carry it in the URL; the unified `signal` route carries it in the body. */
type SignalOp = "publications" | "subscriptions" | "tracks" | "tracks_close" | "tracks_update" | "renegotiate";
/** Method, per-operation path and failure step of each call. */
const ROUTES: Readonly<Record<SignalOp, readonly ["GET" | "POST" | "PUT", string, MediaFailureStep]>> = {
  publications: ["GET", "publications", "sfu_publications"],
  subscriptions: ["GET", "subscriptions", "sfu_subscriptions"],
  tracks: ["POST", "tracks", "sfu_tracks"],
  tracks_close: ["PUT", "tracks/close", "sfu_close_tracks"],
  tracks_update: ["PUT", "tracks/update", "sfu_tracks"],
  renegotiate: ["POST", "renegotiate", "sfu_renegotiate"],
};
/** The calls that change nothing, so a second send cannot do harm. The unified route carries them as POST, so the operation decides, not the method. */
const READS: ReadonlySet<SignalOp> = new Set(["publications", "subscriptions"]);

export function createCloudflareSFUHTTPTransport(options: CloudflareSFUHTTPTransportOptions): CloudflareSFUSignalingTransport {
  const fetch = withRequestContext(options.fetch);
  const credential = requireCredential(options);
  let lastToken = "";
  const base = trimTrailingSlashes(options.apiBaseURL);
  const subject = { tenantId: options.tenantId, spaceId: options.spaceId, episodeId: options.episodeId, participantId: options.participantId };
  const direct = directOrigin(options.directBaseURL);
  const directMemory = options.directMemory ?? sharedDirectPathMemory;
  let probe: Promise<boolean> | undefined;
  /** Whether the direct door answers: one cheap request that starts with the transport and overlaps the work before the first call. */
  const directAnswers = async (): Promise<boolean> => {
    if (!direct || directPathBlocked(directMemory, direct.host, Date.now())) return false;
    probe ??= probeDirectPath(direct, options.fetch ?? globalThis.fetch.bind(globalThis)).then((answered) => {
      if (!answered) forgetDirectProbe();
      return answered;
    });
    return probe;
  };
  /** Marks the door failed for the memory period and drops the probe result, so a recovered door is probed again once the memory expires. */
  const forgetDirectProbe = () => {
    if (direct) markDirectPathFailed(directMemory, direct.host, Date.now());
    probe = undefined;
  };
  if (direct) void directAnswers();
  let announced: string | undefined;
  const announce = (path: "direct" | "tunnel", fellBack: boolean) => {
    const key = `${path}:${fellBack}`;
    if (key === announced) return;
    announced = key;
    notifyObserver(() => options.onPath?.({ plane: "signalling", path, fellBack }));
  };
  const statsPath = apiUrls.callStats(base, options.tenantId);
  const timeoutMs = options.requestTimeoutMs ?? SIGNALING_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CloudflareSFUError("The signaling deadline is invalid", "signaling_failed");
  const freshToken = async (op?: SignalOp): Promise<string> => {
    const startedAt = performance.now();
    try {
      lastToken = nonEmptyToken(await withDeadline(CREDENTIAL_TIMEOUT_MS, (signal) => credential(signal)));
      return lastToken;
    } finally {
      // A user-timing entry shows in a latency run whether the credential provider waits on a network round trip.
      if (op) notifyObserver(() => performance.measure("chalk.sfu.credential", { start: startedAt, end: performance.now(), detail: { op } }));
    }
  };
  /**
   * Sends one signaling call. `query` holds the options the per-operation tracks route reads from its query string;
   * the unified route reads them from the body. The unified route is used only when the API advertised it for this connection.
   */
  const request = async <T>(op: SignalOp, body?: Readonly<Record<string, unknown>>, query: Readonly<Record<string, string | true>> = {}): Promise<T> => {
    try {
      let token = await freshToken(op);
      const [method, path] = ROUTES[op];
      const targetAt = (origin: string) => {
        const mediaPath = apiUrls.mediaSignalling(origin, subject);
        return options.unifiedSignaling
          ? { url: `${mediaPath}/signal`, method: "POST", body: JSON.stringify({ op, ...unifiedBody(op, body), ...query }) }
          : { url: `${mediaPath}/${path}${Object.keys(query).length ? `?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}` : ""}`, method, body: body && JSON.stringify(body) };
      };
      const send = (origin: string): Promise<T> =>
        withDeadline(timeoutMs, async (signal) => {
          const target = targetAt(origin);
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
            notifyObserver(() => options.onDiagnostic?.({ event: "media_http_error", http_status: response.status, duration_ms: performance.now() - startedAt }));
            throw new CloudflareSFUError(`Chalk SFU signaling failed with HTTP ${response.status}`, "signaling_failed", {
              status: response.status,
              retryableConnection: response.status === 404 || response.status === 410 || (response.status >= 500 && response.status < 600),
            });
          }
          return (await response.json()) as T;
        });
      // A 403 can mean the token and the connection fell out of step for a moment (a grant was reissued), so the request is repeated once with a fresh grant.
      const sendWithRegrant = async (origin: string): Promise<T> => {
        try {
          return await send(origin);
        } catch (error) {
          if (!options.refreshCredential || !(error instanceof CloudflareSFUError) || error.options.status !== 403) throw error;
          const refresh = options.refreshCredential;
          token = lastToken = nonEmptyToken(await withDeadline(CREDENTIAL_TIMEOUT_MS, (signal) => refresh(signal)));
          return await send(origin);
        }
      };
      if (direct && (await directAnswers())) {
        try {
          const result = await sendWithRegrant(direct.origin);
          announce("direct", false);
          return result;
        } catch (error) {
          // A write that left the browser may have been applied; the protocol has no idempotency key, so only a read is sent twice.
          const unreachable = neverReachedApi(error);
          if (unreachable || isSignalingTimeout(error)) forgetDirectProbe();
          if (!(unreachable && READS.has(op))) {
            announce("direct", false);
            throw error;
          }
        }
      }
      announce("tunnel", direct !== null);
      return await sendWithRegrant(base);
    } catch (error) {
      markMediaFailure(error, ROUTES[op][2]);
      throw error;
    }
  };
  return {
    addTracks: async (input) => {
      const response = await request<TracksWireResponse>(
        "tracks",
        { connection_id: input.connectionId, session_description: input.sessionDescription, tracks: input.tracks },
        { ...(input.allowPartialRemoteTracks ? { allow_partial_remote_tracks: true as const } : {}), ...(input.replacementCause ? { replacement_cause: input.replacementCause } : {}) },
      );
      return tracksResponse(response);
    },
    closeTracks: async (input) =>
      request<CloudflareSFUTracksResponse>("tracks_close", {
        connection_id: input.connectionId,
        session_description: input.sessionDescription,
        tracks: input.tracks.map((track) => ({ mid: track.mid, source: track.source, publication_id: track.publicationId })),
        force: input.force,
        ...(input.receiveOnly ? { receive_only: true } : {}),
      }),
    updateTracks: async (input) =>
      request<CloudflareSFUTracksResponse>("tracks_update", {
        connection_id: input.connectionId,
        tracks: input.tracks.map(({ publicationId, ...track }) => (publicationId === undefined ? track : { ...track, publication_id: publicationId })),
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
    listPublications: async (): Promise<CloudflareSFUPublicationSnapshot> => publicationSnapshot(await request<WirePublicationList>("publications")),
    pullPublishedAudio: async (input) => {
      const { publications, ...response } = await request<TracksWireResponse & { readonly publications?: WirePublicationList }>("tracks", { connection_id: input.connectionId, tracks: [], pull_published_audio: true }, { allow_partial_remote_tracks: true });
      if (!publications) throw new CloudflareSFUError("The pull-published response carried no publications", "signaling_failed");
      return { snapshot: publicationSnapshot(publications), response: tracksResponse(response) };
    },
  };
}
/** Observers cannot interrupt signaling. */
function notifyObserver(observer: () => void): void {
  try {
    observer();
  } catch {
    /* Dropped on purpose. */
  }
}
function nonEmptyToken(token: string): string {
  if (!token.trim()) throw new CloudflareSFUError("The media credential provider returned an empty token", "signaling_failed");
  return token;
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
    readonly paused?: boolean;
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
      ...(publication.paused ? { paused: true } : {}),
    })),
  };
}
/** The unified route names the close list `close_tracks`, because `tracks` there is the list of tracks to add or update. */
function unifiedBody(op: SignalOp, body: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  if (op !== "tracks_close" || !body) return body;
  const { tracks, ...rest } = body;
  return { ...rest, close_tracks: tracks };
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
/** One request to the direct host's catch-all route: any HTTP answer, even a 404, proves TCP and TLS work. Resolves false on a network failure or after the attempt budget. */
async function probeDirectPath(direct: URL, fetch: typeof globalThis.fetch): Promise<boolean> {
  try {
    await withDeadline(DIRECT_PATH_ATTEMPT_TIMEOUT_MS, (signal) => fetch(`${direct.origin}/`, { mode: "no-cors", cache: "no-store", credentials: "omit", signal }));
    return true;
  } catch {
    return false;
  }
}
/**
 * A failure that proves the API never handled the call, so replaying it on the Tunnel cannot apply it twice:
 * the connection failed (a rejected fetch), the proxy could not reach the API (502, 503) or its per-client bound refused it (429).
 * A timeout or a 504 may follow a call the API already handled, so those surface as they do on the Tunnel.
 */
function isSignalingTimeout(error: unknown): boolean {
  return error instanceof CloudflareSFUError && error.code === "signaling_timeout";
}

function neverReachedApi(error: unknown): boolean {
  if (error instanceof CloudflareSFUError) return error.options.status === 429 || error.options.status === 502 || error.options.status === 503;
  return error instanceof TypeError;
}
