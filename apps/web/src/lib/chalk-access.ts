import type { AccessGrant, GetAccess } from "@q9labsai/chalk-client";
import type { SpaceClientPlatform } from "@q9labsai/chalk-client/effect";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

const localBackendPath = "/local-chalk";

export type ParticipantCredential = {
  readonly apiBaseURL: string;
  readonly syncURL: string;
  readonly spaceInviteToken?: string;
};

export type DashboardSpaceCredential = {
  readonly apiBaseURL: string;
  readonly space: string;
  readonly access: AccessGrant;
  readonly participantGeneration: number;
};

export type DashboardSpaceAccess = {
  readonly credential: DashboardSpaceCredential;
  readonly getAccess: GetAccess;
  readonly connectionAccess: NonNullable<SpaceClientPlatform["connectionAccess"]>;
  readonly leave: (options?: ParticipantCredentialCleanupOptions) => Promise<void>;
};

type JourneyBrokerTelemetry = Pick<TelemetryJourney, "headers" | "recordHttpRequest">;

export type ParticipantCredentialCleanupOptions = {
  readonly keepalive?: boolean;
};

export async function createParticipantCredential(displayName: string, spaceInviteToken?: string, journey?: JourneyBrokerTelemetry): Promise<ParticipantCredential> {
  try {
    return await request(
      "/participant-credentials",
      {
        displayName,
        ...(spaceInviteToken ? { spaceInviteToken } : {}),
      },
      journey,
      parseParticipantCredential,
    );
  } catch (cause) {
    if (cause instanceof ParticipantCredentialResponseError) await cleanupParticipantCredential(journey).catch(() => undefined);
    throw cause;
  }
}

export function createAccessGrantProvider(journey?: JourneyBrokerTelemetry): GetAccess {
  return async (): Promise<AccessGrant> => request<AccessGrant>("/access-grants", undefined, journey);
}

export async function cleanupParticipantCredential(journey?: JourneyBrokerTelemetry, options: ParticipantCredentialCleanupOptions = {}): Promise<void> {
  await request<void>("/participant-credentials/cleanup", undefined, journey, undefined, options);
}

/** Account-bound Dashboard access never persists the opaque grant in storage. */
export async function joinDashboardSpace(tenantID: string, spaceSlug: string, displayName: string, journey?: JourneyBrokerTelemetry): Promise<DashboardSpaceAccess> {
  const path = `/api/tenants/${encodeURIComponent(tenantID)}/spaces/by-slug/${encodeURIComponent(spaceSlug)}/participants/self`;
  const value = await dashboardRequest(path, "POST", { display_name: displayName }, journey);
  const parsed = parseDashboardGrant(value);
  let current = parsed;
  let initial = true;
  let left = false;
  const connectionAccess: NonNullable<SpaceClientPlatform["connectionAccess"]> = async (request) => {
    if (left) throw new Error("Dashboard Space access has been released.");
    if (initial && (!request || request.reason === "join")) {
      initial = false;
      return current.access;
    }
    const refreshed = await dashboardRequest(
      `${path}/access-grants`,
      "POST",
      {
        participant_generation: current.participantGeneration,
        replace_media_connection: request?.replaceMediaConnection ?? false,
        ...(request?.currentMediaToken ? { current_media_token: request.currentMediaToken } : {}),
      },
      journey,
    );
    current = parseDashboardGrant(refreshed);
    return current.access;
  };
  const getAccess: GetAccess = async () => connectionAccess();
  const leave = async (options: ParticipantCredentialCleanupOptions = {}): Promise<void> => {
    if (left) return;
    left = true;
    await dashboardRequest(path, "DELETE", { participant_generation: current.participantGeneration }, journey, options);
  };
  return {
    credential: { apiBaseURL: dashboardAPIBaseURL(), space: spaceSlug, access: current.access, participantGeneration: current.participantGeneration },
    getAccess,
    connectionAccess,
    leave,
  };
}

export function isUnauthenticatedDashboardSpaceError(cause: unknown): boolean {
  return cause instanceof DashboardSpaceRequestError && cause.status === 401;
}

async function request<T>(path: string, body: unknown = {}, journey?: JourneyBrokerTelemetry, parse?: (value: unknown) => T, options: ParticipantCredentialCleanupOptions = {}): Promise<T> {
  const startedAt = Date.now();
  let response: Response | undefined;

  try {
    response = await fetch(`${localBackendPath}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...journey?.headers },
      body: JSON.stringify(body ?? {}),
      keepalive: options.keepalive,
    });
    if (!response.ok) {
      journey?.recordHttpRequest({
        method: "POST",
        route: `${localBackendPath}${path}`,
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        state: "failed",
      });
      const message = await errorMessage(response);
      throw new ParticipantCredentialRequestError(message, response.status);
    }
    if (response.status === 204) {
      journey?.recordHttpRequest({
        method: "POST",
        route: `${localBackendPath}${path}`,
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        state: "succeeded",
      });
      return undefined as T;
    }
    try {
      const value: unknown = await response.json();
      const result = parse ? parse(value) : (value as T);
      journey?.recordHttpRequest({
        method: "POST",
        route: `${localBackendPath}${path}`,
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        state: "succeeded",
      });
      return result;
    } catch (cause) {
      journey?.recordHttpRequest({
        method: "POST",
        route: `${localBackendPath}${path}`,
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        state: "failed",
      });
      throw cause;
    }
  } catch (cause) {
    if (!response) {
      journey?.recordHttpRequest({
        method: "POST",
        route: `${localBackendPath}${path}`,
        durationMs: Date.now() - startedAt,
        state: "failed",
      });
    }
    throw cause;
  }
}

let csrfToken: string | undefined;

async function dashboardRequest(path: string, method: "POST" | "DELETE", body: unknown, journey?: JourneyBrokerTelemetry, options: ParticipantCredentialCleanupOptions = {}): Promise<unknown> {
  const startedAt = Date.now();
  const key = requestKey();
  const tokenResponse = await fetch("/api/auth/csrf", { credentials: "same-origin" });
  if (!tokenResponse.ok) throw new DashboardSpaceRequestError("Could not establish secure Dashboard access.", tokenResponse.status);
  const tokenBody = (await tokenResponse.json()) as { readonly csrf_token?: unknown };
  csrfToken = typeof tokenBody.csrf_token === "string" ? tokenBody.csrf_token : csrfToken;
  if (!csrfToken) throw new Error("Could not establish secure Dashboard access.");
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-chalk-csrf": csrfToken, "idempotency-key": key, ...journey?.headers },
    body: JSON.stringify(body ?? {}),
    keepalive: options.keepalive,
  });
  journey?.recordHttpRequest({ method, route: path, statusCode: response.status, durationMs: Date.now() - startedAt, state: response.ok ? "succeeded" : "failed" });
  if (!response.ok) throw new DashboardSpaceRequestError(await errorMessage(response), response.status);
  if (response.status === 204) return undefined;
  return response.json();
}

function parseDashboardGrant(value: unknown): { readonly access: AccessGrant; readonly participantGeneration: number } {
  if (!isRecord(value) || !isRecord(value.subject) || !isRecord(value.sync) || !isRecord(value.media)) throw new Error("The Dashboard access grant response was invalid.");
  const generation = value.subject.participant_generation;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || typeof value.sync.token !== "string" || typeof value.media.token !== "string") throw new Error("The Dashboard access grant response was invalid.");
  return { access: value as AccessGrant, participantGeneration: generation };
}

function dashboardAPIBaseURL(): string {
  const configured = (import.meta as ImportMeta & { readonly env?: Record<string, unknown> }).env?.VITE_API_URL;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return globalThis.location?.origin ?? "http://localhost";
}

function requestKey(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 32);
}

function parseParticipantCredential(value: unknown): ParticipantCredential {
  if (!isRecord(value)) throw new ParticipantCredentialResponseError("The participant credential response was invalid.");

  return {
    apiBaseURL: endpoint(value.apiBaseURL, ["http", "https"], "API"),
    syncURL: endpoint(value.syncURL, ["ws", "wss"], "Sync"),
    ...(value.spaceInviteToken === undefined ? {} : { spaceInviteToken: capability(value.spaceInviteToken, "Space invite") }),
  };
}

function endpoint(value: unknown, protocols: readonly string[], label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) throw new ParticipantCredentialResponseError(`The participant credential returned an invalid ${label} URL.`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ParticipantCredentialResponseError(`The participant credential returned an invalid ${label} URL.`);
  }
  if (!protocols.includes(url.protocol.slice(0, -1)) || url.username || url.password || url.hash) throw new ParticipantCredentialResponseError(`The participant credential returned an invalid ${label} URL.`);
  return value;
}

function capability(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new ParticipantCredentialResponseError(`The participant credential returned an invalid ${label}.`);
  return value;
}

class ParticipantCredentialResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParticipantCredentialResponseError";
  }
}

class ParticipantCredentialRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ParticipantCredentialRequestError";
  }
}

class DashboardSpaceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DashboardSpaceRequestError";
  }
}

export function isTerminalParticipantCredentialCleanupError(cause: unknown): boolean {
  return cause instanceof ParticipantCredentialRequestError && [401, 404, 410].includes(cause.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) return body.error;
  } catch {
    // The HTTP status remains useful when a proxy returns a non-JSON error page.
  }
  return `The Chalk access service returned HTTP ${response.status}`;
}
