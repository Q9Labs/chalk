import { createChalkPublicClient, type AccessGrant, type AccessGrantSource, type GetAccess, type PublicArrivalOptions, type PublicSpaceArrival, type PublicSpaceCreated } from "@q9labsai/chalk-client";
import type { SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

export type PublicSpaceCredential = {
  readonly apiBaseURL: string;
  readonly syncURL: string;
  readonly space: string;
};

export type AccountSpaceCredential = {
  readonly apiBaseURL: string;
  readonly space: string;
  readonly access: AccessGrantSource;
  readonly participantGeneration: number;
};

export type AccountSpaceAccess = {
  readonly credential: AccountSpaceCredential;
  readonly getAccess: GetAccess;
  readonly leave: (options?: SpaceAccessCleanupOptions) => Promise<void>;
  readonly inviteLink?: string;
};

export type SpaceAccessCleanupOptions = {
  readonly keepalive?: boolean;
};

export type PublicInviteClient = {
  readonly createPublicSpace: (displayName: string) => Promise<PublicSpaceCreated>;
  readonly arriveBySpacePublicInvite: (spaceInviteToken: string, displayName: string, options?: Pick<PublicArrivalOptions, "arrivalHandle">) => Promise<PublicSpaceArrival>;
  readonly getSpacePublicInviteArrival: (arrivalHandle: string) => Promise<PublicSpaceArrival>;
  readonly refreshSpacePublicInviteAccess: (arrivalHandle: string, mediaProof: string, replaceMediaConnection?: boolean) => Promise<AccessGrant>;
  readonly leaveSpacePublicInviteArrival: (arrivalHandle: string, options?: SpaceAccessCleanupOptions) => Promise<void>;
};

export type PreparedPublicSpace = {
  readonly arrival: PublicSpaceArrival;
  readonly credential: PublicSpaceCredential | AccountSpaceCredential;
  readonly getAccess: GetAccess;
  readonly connectionAccess: NonNullable<SpaceClientPlatform["connectionAccess"]>;
  readonly finish: (options?: SpaceAccessCleanupOptions) => Promise<void>;
};

type PreparedPublicSpaceOptions = {
  readonly reenter?: () => Promise<PublicSpaceArrival>;
};

type JourneyOptions = Pick<TelemetryJourney, "headers"> & {
  readonly context?: TelemetryJourney["context"];
  readonly recordHttpRequest?: TelemetryJourney["recordHttpRequest"];
};

const defaultAPIOrigin = "https://api.chalkmeet.com";
const dashboardCSRF: { token?: string; expiresAt: number } = { token: undefined, expiresAt: 0 };
const dashboardRequestTimeoutMS = 15_000;

export function createPublicInviteClient(journey?: JourneyOptions): PublicInviteClient {
  const client = createChalkPublicClient({
    baseUrl: publicAPIBaseURL(),
    credentials: "include",
    ...(journey?.headers ? { headers: journey.headers } : {}),
    ...(journey?.context ? { telemetry: journey.context } : {}),
  });

  return {
    createPublicSpace: (displayName) => client.createPublicSpace({ displayName }, { idempotencyKey: requestKey() }),
    arriveBySpacePublicInvite: (spaceInviteToken, displayName, options) => client.arriveBySpacePublicInvite({ spaceInviteToken, displayName }, { idempotencyKey: requestKey(), ...(options?.arrivalHandle === undefined ? {} : { arrivalHandle: options.arrivalHandle }) }),
    getSpacePublicInviteArrival: (arrivalHandle) => client.getSpacePublicInviteArrival({ arrivalHandle }),
    refreshSpacePublicInviteAccess: (arrivalHandle, mediaProof, replaceMediaConnection) =>
      client.refreshSpacePublicInviteAccess({ mediaProof, arrivalHandle, ...(replaceMediaConnection === undefined ? {} : { replaceMediaConnection }) }),
    leaveSpacePublicInviteArrival: (arrivalHandle, options) => client.leaveSpacePublicInviteArrival(arrivalHandle, options),
  };
}

export async function joinDashboardSpace(tenantID: string, spaceSlug: string, displayName: string, journey?: JourneyOptions): Promise<AccountSpaceAccess> {
  const path = `/api/tenants/${encodeURIComponent(tenantID)}/spaces/by-slug/${encodeURIComponent(spaceSlug)}/participants/self`;
  const current = dashboardGrant(await dashboardRequest(path, "POST", { display_name: displayName }, journey));
  const inviteLink = await dashboardInviteLink(current.tenantID, current.spaceID, journey);
  let active = current;
  let initial = true;
  let left = false;

  const getAccess: GetAccess = async ({ reason }) => {
    if (left) throw new Error("This Space access has been released.");
    if (initial && reason === "join") {
      initial = false;
      return active.access;
    }
    active = dashboardGrant(
      await dashboardRequest(
        `${path}/access-grants`,
        "POST",
        {
          participant_generation: active.participantGeneration,
          replace_media_connection: reason === "retry",
          ...(reason === "retry" ? {} : { current_media_token: active.mediaToken }),
        },
        journey,
      ),
    );
    return active.access;
  };

  const leave = async (options: SpaceAccessCleanupOptions = {}): Promise<void> => {
    if (left) return;
    await dashboardRequest(path, "DELETE", { participant_generation: active.participantGeneration }, journey, options);
    left = true;
  };

  return {
    credential: { apiBaseURL: publicAPIBaseURL(), space: active.spaceID, access: active.access, participantGeneration: active.participantGeneration },
    getAccess,
    leave,
    inviteLink,
  };
}

export function createPreparedPublicSpace(client: PublicInviteClient, arrival: PublicSpaceArrival, options: PreparedPublicSpaceOptions = {}): PreparedPublicSpace {
  let currentArrival = arrival;
  const access = requireArrivalAccess(currentArrival);
  let mediaProof = accessMediaProof(access);
  let current = access;
  let left = false;
  let currentArrivalReleased = false;
  let initial = true;

  const connectionAccess: NonNullable<SpaceClientPlatform["connectionAccess"]> = async (request) => {
    if (left) throw new Error("This Space access has been released.");
    if (initial && (!request || request.reason === "join")) {
      initial = false;
      return current;
    }
    if ((!request || request.reason === "join") && options.reenter) {
      const arrivalHandle = currentArrival.arrival_handle;
      if (arrivalHandle && !currentArrivalReleased) {
        await client.leaveSpacePublicInviteArrival(arrivalHandle);
        currentArrivalReleased = true;
      }
      currentArrival = await options.reenter();
      current = requireArrivalAccess(currentArrival);
      mediaProof = accessMediaProof(current);
      currentArrivalReleased = false;
      return current;
    }
    mediaProof = request?.currentMediaToken ?? mediaProof;
    current = await client.refreshSpacePublicInviteAccess(currentArrival.arrival_handle ?? "", mediaProof, request?.replaceMediaConnection ?? false);
    mediaProof = accessMediaProof(current);
    return current;
  };
  const getAccess: GetAccess = async ({ reason }) => connectionAccess({ reason: reason === "join" ? "join" : reason === "refresh" ? "scheduled_refresh" : "access_retry", replaceMediaConnection: reason === "retry" });
  const finish = async (options: SpaceAccessCleanupOptions = {}): Promise<void> => {
    if (left) return;
    const arrivalHandle = currentArrival.arrival_handle;
    if (arrivalHandle && !currentArrivalReleased) await client.leaveSpacePublicInviteArrival(arrivalHandle, options);
    left = true;
  };

  return {
    get arrival() {
      return currentArrival;
    },
    credential: { apiBaseURL: publicAPIBaseURL(), syncURL: publicSyncURL(publicAPIBaseURL()), space: publicSpaceSlug(currentArrival) },
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

export function publicSyncURL(apiBaseURL: string): string {
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

type DashboardGrant = {
  readonly access: AccessGrantSource;
  readonly mediaToken: string;
  readonly participantGeneration: number;
  readonly tenantID: string;
  readonly spaceID: string;
};

function dashboardGrant(value: unknown): DashboardGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("This Space is unavailable.");
  const subject = "subject" in value && typeof value.subject === "object" && value.subject !== null && !Array.isArray(value.subject) ? value.subject : undefined;
  const media = "media" in value && typeof value.media === "object" && value.media !== null && !Array.isArray(value.media) ? value.media : undefined;
  const generation = subject && "participant_generation" in subject ? subject.participant_generation : undefined;
  const tenantID = subject && "tenant_id" in subject ? subject.tenant_id : undefined;
  const spaceID = subject && "space_id" in subject ? subject.space_id : undefined;
  const mediaToken = media && "token" in media ? media.token : undefined;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || typeof mediaToken !== "string" || !mediaToken || typeof tenantID !== "string" || !tenantID || typeof spaceID !== "string" || !spaceID) throw new Error("This Space is unavailable.");
  return { access: value, mediaToken, participantGeneration: generation, tenantID, spaceID };
}

function accessMediaProof(access: AccessGrant): string {
  const value: unknown = access;
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("media" in value) || typeof value.media !== "object" || value.media === null || Array.isArray(value.media) || !("token" in value.media) || typeof value.media.token !== "string" || !value.media.token) {
    throw new Error("This Space is unavailable.");
  }
  return value.media.token;
}

async function dashboardRequest(path: string, method: "GET" | "POST" | "DELETE", body: unknown, journey?: JourneyOptions, options: SpaceAccessCleanupOptions = {}): Promise<unknown> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), dashboardRequestTimeoutMS);
  let statusCode: number | undefined;
  try {
    const csrf = method === "GET" ? undefined : await dashboardCSRFToken(controller.signal);
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { ...(method === "GET" ? {} : { "content-type": "application/json", "x-chalk-csrf": csrf ?? "", "idempotency-key": requestKey() }), ...(journey?.headers ?? {}) },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      keepalive: options.keepalive,
      signal: controller.signal,
    });
    statusCode = response.status;
    journey?.recordHttpRequest?.({ method, route: path, statusCode, durationMs: Date.now() - startedAt, state: response.ok ? "succeeded" : "failed" });
    if (!response.ok) throw new Error("This Space is unavailable.");
    if (response.status === 204) return undefined;
    return response.json();
  } catch (cause) {
    if (!statusCode) journey?.recordHttpRequest?.({ method, route: path, durationMs: Date.now() - startedAt, state: "failed" });
    if (controller.signal.aborted) throw new Error("This Space is unavailable.");
    throw cause;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function dashboardCSRFToken(signal: AbortSignal): Promise<string> {
  if (dashboardCSRF.token && dashboardCSRF.expiresAt > Date.now()) return dashboardCSRF.token;
  const response = await fetch("/api/auth/csrf", { credentials: "same-origin", headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new Error("This Space is unavailable.");
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("csrf_token" in value) || typeof value.csrf_token !== "string" || !value.csrf_token) throw new Error("This Space is unavailable.");
  dashboardCSRF.token = value.csrf_token;
  dashboardCSRF.expiresAt = Date.now() + 55 * 60 * 1_000;
  return value.csrf_token;
}

async function dashboardInviteLink(tenantID: string, spaceID: string, journey?: JourneyOptions): Promise<string | undefined> {
  const value = await dashboardRequest(`/api/tenants/${encodeURIComponent(tenantID)}/spaces/${encodeURIComponent(spaceID)}/public-invite`, "GET", undefined, journey);
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("canonical_url" in value) || typeof value.canonical_url !== "string") return undefined;
  const inviteLink = value.canonical_url.trim();
  return inviteLink || undefined;
}

function publicSpaceSlug(arrival: PublicSpaceArrival): string {
  const slug = arrival.space?.slug?.trim();
  if (!slug) throw new Error("This Space is unavailable.");
  return slug;
}
