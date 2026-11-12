import { parseParsedAccessGrant, type AccessGrant } from "../access/grant.js";
import type { ConnectionAccessRequest } from "../connection/dependencies.js";
import { reloadRejoinAccess, resumeReloadRejoin, type ReloadRejoinMarker } from "../space-client/reload-rejoin.js";
import type { GetAccess } from "../space-client/types.js";
import { isTerminalArrivalError } from "./entrance.js";
import type { ChalkPublicClient, PublicLeaveOptions, PublicSpaceArrival } from "./types.js";

/** What an admitted arrival holds: its handle and the first grant. */
export type AdmittedArrival = { readonly arrivalHandle: string; readonly access: AccessGrant };

export type PublicSpaceSessionOptions = {
  /** Sent with every refresh and leave. Only the React Native runtime uses it. */
  readonly guestCredential?: string;
  /** Called after each refresh finishes, so an app can record it. */
  readonly onRefresh?: (outcome: "succeeded" | "failed") => void;
};

/**
 * The access an admitted public arrival holds for one Space. It hands `SpaceClient` the first grant,
 * trades the media token for a fresh grant whenever the client asks, and gives the arrival back once.
 */
export type PublicSpaceSession = {
  readonly getAccess: GetAccess;
  readonly connectionAccess: (request?: ConnectionAccessRequest) => Promise<AccessGrant>;
  /** Called after each refresh. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly mediaProof: () => string;
  /** Epoch milliseconds at which the current media token expires. */
  readonly mediaExpiresAt: () => number;
  readonly reloadMarker: () => Pick<ReloadRejoinMarker, "episodeId" | "participantId" | "participantGeneration" | "mediaProof" | "arrivalHandle" | "tenantId">;
  /** Gives the arrival back. Calls that overlap share one request, a call after it succeeded does nothing, and a failed leave can be tried again. An arrival the server already dropped counts as left. */
  readonly leave: (options?: PublicLeaveOptions) => Promise<void>;
};

export function createPublicSpaceSession(client: ChalkPublicClient, { arrivalHandle, access: first }: AdmittedArrival, options: PublicSpaceSessionOptions = {}): PublicSpaceSession {
  const reference = { arrivalHandle, guestCredential: options.guestCredential };
  const listeners = new Set<() => void>();
  let current = first;
  let mediaProof = parseParsedAccessGrant(first).media.token;
  let initial = true;
  let left = false;
  let leaving: Promise<void> | undefined;

  const refresh = async (request?: ConnectionAccessRequest): Promise<AccessGrant> => {
    mediaProof = request?.currentMediaToken ?? mediaProof;
    try {
      current = await client.refreshSpacePublicInviteAccess({ ...reference, mediaProof, replaceMediaConnection: request?.replaceMediaConnection, signal: request?.signal });
    } catch (cause) {
      options.onRefresh?.("failed");
      throw cause;
    }
    options.onRefresh?.("succeeded");
    mediaProof = parseParsedAccessGrant(current).media.token;
    listeners.forEach((listener) => listener());
    return current;
  };

  const connectionAccess = async (request?: ConnectionAccessRequest): Promise<AccessGrant> => {
    if (left) throw new Error("This Space access has been released.");
    if (initial && (!request || request.reason === "join")) {
      initial = false;
      return current;
    }
    return refresh(request);
  };

  return {
    connectionAccess,
    getAccess: ({ reason, signal }) => connectionAccess({ reason: reason === "join" ? "join" : reason === "refresh" ? "scheduled_refresh" : "access_retry", replaceMediaConnection: reason === "retry", signal }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mediaProof: () => mediaProof,
    mediaExpiresAt: () => Date.parse(parseParsedAccessGrant(current).media.expiresAt),
    reloadMarker: () => ({ ...reloadRejoinAccess(current), arrivalHandle }),
    leave: (leaveOptions) => {
      if (left) return Promise.resolve();
      leaving ??= client.leaveSpacePublicInviteArrival(reference, leaveOptions).then(
        () => {
          left = true;
        },
        (cause: unknown) => {
          leaving = undefined;
          if (!isTerminalArrivalError(cause)) throw cause;
          left = true;
        },
      );
      return leaving;
    },
  };
}

/** Rebuilds the session of a reloaded tab from its marker, and refuses an arrival that is no longer admitted to `expectedSlug`. */
export async function resumePublicSpaceSession(client: ChalkPublicClient, marker: ReloadRejoinMarker, expectedSlug?: string): Promise<{ readonly session: PublicSpaceSession; readonly arrival: PublicSpaceArrival }> {
  if (!marker.arrivalHandle) throw new Error("This Space is unavailable.");
  const reference = { arrivalHandle: marker.arrivalHandle };
  const arrival = await client.getSpacePublicInviteArrival(reference);
  if (arrival.state !== "admitted" || (expectedSlug !== undefined && arrival.space?.slug !== expectedSlug)) throw new Error("This Space is unavailable.");
  const access = await resumeReloadRejoin(marker, () => client.refreshSpacePublicInviteAccess({ ...reference, mediaProof: marker.mediaProof, replaceMediaConnection: true }));
  return { session: createPublicSpaceSession(client, { arrivalHandle: marker.arrivalHandle, access }), arrival };
}
