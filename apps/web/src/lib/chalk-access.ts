import { createChalkPublicClient, reloadRejoinAccess, resumeReloadRejoin, type ReloadRejoinMarker, type AccessGrant, type GetAccess, type PublicArrivalOptions, type PublicSpaceArrival, type PublicSpaceCreated } from "@q9labsai/chalk-client";
import type { SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import { z } from "zod";
export type PublicSpaceCredential = {
  readonly apiBaseURL: string;
  readonly syncURL: string;
  readonly space: string;
};
export type SpaceAccessCleanupOptions = {
  readonly keepalive?: boolean;
};
export type PublicInviteClient = {
  readonly prepareSpaceEntrance: (spaceInviteToken: string) => Promise<void>;
  readonly createPublicSpace: (displayName: string) => Promise<PublicSpaceCreated>;
  readonly arriveBySpacePublicInvite: (spaceInviteToken: string, displayName: string, options?: Pick<PublicArrivalOptions, "arrivalHandle">) => Promise<PublicSpaceArrival>;
  readonly getSpacePublicInviteArrival: (arrivalHandle: string) => Promise<PublicSpaceArrival>;
  readonly refreshSpacePublicInviteAccess: (
    arrivalHandle: string,
    mediaProof: string,
    options?: {
      readonly replaceMediaConnection?: boolean;
      readonly signal?: AbortSignal;
    },
  ) => Promise<AccessGrant>;
  readonly leaveSpacePublicInviteArrival: (arrivalHandle: string, options?: SpaceAccessCleanupOptions) => Promise<void>;
};
export type PreparedPublicSpace = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly reportCredential: () => string;
  readonly reportCredentialExpiresAt: () => number;
  readonly reloadMarker: () => Pick<ReloadRejoinMarker, "episodeId" | "participantId" | "participantGeneration" | "mediaProof" | "arrivalHandle" | "tenantId">;
  readonly arrival: PublicSpaceArrival;
  readonly credential: PublicSpaceCredential;
  readonly getAccess: GetAccess;
  readonly connectionAccess: NonNullable<SpaceClientPlatform["connectionAccess"]>;
  readonly finish: (options?: SpaceAccessCleanupOptions) => Promise<void>;
};
const defaultAPIOrigin = "https://api.chalkmeet.com";
export function createPublicInviteClient(): PublicInviteClient {
  const client = createChalkPublicClient({
    baseUrl: publicAPIBaseURL(),
    credentials: "include",
  });
  return {
    prepareSpaceEntrance: (spaceInviteToken) => client.prepareSpaceEntrance(spaceInviteToken),
    createPublicSpace: (displayName) => client.createPublicSpace({ displayName }, { idempotencyKey: requestKey() }),
    arriveBySpacePublicInvite: (spaceInviteToken, displayName, options) => client.arriveBySpacePublicInvite({ spaceInviteToken, displayName }, { idempotencyKey: requestKey(), ...(options?.arrivalHandle === undefined ? {} : { arrivalHandle: options.arrivalHandle }) }),
    getSpacePublicInviteArrival: (arrivalHandle) => client.getSpacePublicInviteArrival({ arrivalHandle }),
    refreshSpacePublicInviteAccess: (arrivalHandle, mediaProof, options) => client.refreshSpacePublicInviteAccess({ mediaProof, arrivalHandle, replaceMediaConnection: options?.replaceMediaConnection, signal: options?.signal }),
    leaveSpacePublicInviteArrival: (arrivalHandle, options) => client.leaveSpacePublicInviteArrival(arrivalHandle, options),
  };
}
export function createPreparedPublicSpace(client: PublicInviteClient, arrival: PublicSpaceArrival): PreparedPublicSpace {
  const access = requireArrivalAccess(arrival);
  let mediaProof = accessMediaProof(access);
  let current = access;
  let left = false;
  let initial = true;
  const listeners = new Set<() => void>();
  const connectionAccess: NonNullable<SpaceClientPlatform["connectionAccess"]> = async (request) => {
    if (left) throw new Error("This Space access has been released.");
    if (initial && (!request || request.reason === "join")) {
      initial = false;
      return current;
    }
    mediaProof = request?.currentMediaToken ?? mediaProof;
    current = await client.refreshSpacePublicInviteAccess(arrival.arrival_handle ?? "", mediaProof, { replaceMediaConnection: request?.replaceMediaConnection, signal: request?.signal });
    mediaProof = accessMediaProof(current);
    listeners.forEach((listener) => listener());
    return current;
  };
  const getAccess: GetAccess = async ({ reason, signal }) => connectionAccess({ reason: reason === "join" ? "join" : reason === "refresh" ? "scheduled_refresh" : "access_retry", replaceMediaConnection: reason === "retry", signal });
  const finish = async (options: SpaceAccessCleanupOptions = {}): Promise<void> => {
    if (left) return;
    const arrivalHandle = arrival.arrival_handle;
    if (arrivalHandle) await client.leaveSpacePublicInviteArrival(arrivalHandle, options);
    left = true;
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reportCredential: () => mediaProof,
    reportCredentialExpiresAt: () => Date.parse(reportMediaAccess.parse(current).media.expires_at),
    reloadMarker: () => ({ ...reloadRejoinAccess(current), arrivalHandle: arrival.arrival_handle ?? undefined }),
    arrival,
    credential: { apiBaseURL: publicAPIBaseURL(), syncURL: publicSyncURL(publicAPIBaseURL()), space: publicSpaceSlug(arrival) },
    getAccess,
    connectionAccess,
    finish,
  };
}
export function publicAPIBaseURL(): string {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) return configured;
  if (globalThis.location?.origin) return globalThis.location.origin;
  return defaultAPIOrigin;
}
function publicSyncURL(apiBaseURL: string): string {
  const configured = import.meta.env.VITE_CHALK_SYNC_URL?.trim();
  if (configured) return configured;
  const url = new URL(apiBaseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.hostname.startsWith("api.")) url.hostname = `sync.${url.hostname.slice(4)}`;
  url.pathname = "/v1/sync";
  url.search = "";
  url.hash = "";
  return url.toString();
}
function requestKey(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 32);
}
function requireArrivalAccess(arrival: PublicSpaceArrival): AccessGrant {
  if (!arrival.access) throw new Error("This Space is not ready yet.");
  return arrival.access;
}
function accessMediaProof(access: AccessGrant): string {
  const value: unknown = access;
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("media" in value) || typeof value.media !== "object" || value.media === null || Array.isArray(value.media) || !("token" in value.media) || typeof value.media.token !== "string" || !value.media.token) {
    throw new Error("This Space is unavailable.");
  }
  return value.media.token;
}
const reportMediaAccess = z.object({ media: z.object({ expires_at: z.iso.datetime() }) });
function publicSpaceSlug(arrival: PublicSpaceArrival): string {
  const slug = arrival.space?.slug?.trim();
  if (!slug) throw new Error("This Space is unavailable.");
  return slug;
}
export async function resumePublicSpace(client: PublicInviteClient, marker: ReloadRejoinMarker): Promise<PreparedPublicSpace> {
  if (!marker.arrivalHandle) throw new Error("This Space is unavailable.");
  const arrival = await client.getSpacePublicInviteArrival(marker.arrivalHandle);
  if (arrival.state !== "admitted" || arrival.space?.slug !== marker.space) throw new Error("This Space is unavailable.");
  const access = await resumeReloadRejoin(marker, () => client.refreshSpacePublicInviteAccess(marker.arrivalHandle ?? "", marker.mediaProof, { replaceMediaConnection: true }));
  return createPreparedPublicSpace(client, { ...arrival, access });
}
