import type { AccessGrant, GetAccess } from "@q9labsai/chalk-client";
import type { TelemetryJourney } from "@q9labsai/chalk-client/telemetry";

const localBackendPath = "/local-chalk";

export type ParticipantCredential = {
  readonly apiBaseURL: string;
  readonly syncURL: string;
  readonly spaceInviteToken?: string;
};

type JourneyBrokerTelemetry = Pick<TelemetryJourney, "headers" | "recordHttpRequest">;

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

export async function cleanupParticipantCredential(journey?: JourneyBrokerTelemetry): Promise<void> {
  await request<void>("/participant-credentials/cleanup", undefined, journey);
}

async function request<T>(path: string, body: unknown, journey: JourneyBrokerTelemetry | undefined, parse: (value: unknown) => T): Promise<T>;
async function request<T>(path: string, body: unknown, journey: JourneyBrokerTelemetry | undefined, parse?: undefined): Promise<T>;
async function request<T>(path: string, body: unknown = {}, journey?: JourneyBrokerTelemetry, parse?: (value: unknown) => T): Promise<T> {
  const startedAt = Date.now();
  let response: Response | undefined;

  try {
    response = await fetch(`${localBackendPath}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...journey?.headers },
      body: JSON.stringify(body ?? {}),
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
