import { requireParticipantAccess, type ChalkSessionAccessProvider, type ChalkSessionAccessRequest } from "@q9labsai/chalk-client";

import type { TelemetryJourney } from "../telemetry";

const capabilityPattern = /^[A-Za-z0-9_-]{43}$/u;

export type ClientSessionCredential = {
  readonly clientSessionId: string;
  readonly inviteToken: string;
};

export type ClientSession = ClientSessionCredential & {
  readonly apiBaseURL: string;
  readonly syncURL: string;
  readonly meetingLink: string;
  readonly access: ChalkSessionAccessProvider;
  cleanup(): Promise<void>;
};

export type CreateClientSessionOptions = {
  readonly brokerBaseURL: string;
  readonly displayName: string;
  readonly inviteToken?: string;
  readonly credential?: ClientSessionCredential;
  readonly meetingBaseURL?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly telemetry?: TelemetryJourney;
};

export class ClientSessionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClientSessionError";
  }
}

export async function createClientSession(options: CreateClientSessionOptions): Promise<ClientSession> {
  const fetch = options.fetch ?? globalThis.fetch;
  const brokerBaseURL = normalizedBaseURL(options.brokerBaseURL);
  const response = await fetch(`${brokerBaseURL}/client-session`, {
    method: "POST",
    headers: requestHeaders(options.telemetry),
    body: JSON.stringify({
      displayName: options.displayName,
      ...(options.credential
        ? {
            clientSessionId: options.credential.clientSessionId,
            inviteToken: options.credential.inviteToken,
          }
        : options.inviteToken
          ? { inviteToken: options.inviteToken }
          : {}),
    }),
  });
  const session = await requireClientSessionResponse(response);
  const credential = {
    clientSessionId: session.clientSessionId,
    inviteToken: session.inviteToken,
  } satisfies ClientSessionCredential;

  const access = async (request?: ChalkSessionAccessRequest) =>
    requireParticipantAccess(
      await fetch(`${brokerBaseURL}/participant-access`, {
        method: "POST",
        headers: requestHeaders(options.telemetry),
        body: JSON.stringify({
          ...credential,
          replaceMediaConnection: request?.replaceMediaConnection ?? false,
          ...(request?.currentMediaToken ? { currentMediaToken: request.currentMediaToken } : {}),
        }),
      }),
    );

  return {
    ...credential,
    apiBaseURL: session.apiBaseURL,
    syncURL: session.syncURL,
    meetingLink: meetingLink(options.meetingBaseURL ?? brokerBaseURL, session.inviteToken),
    access,
    async cleanup() {
      const cleanupResponse = await fetch(`${brokerBaseURL}/client-session/cleanup`, {
        method: "POST",
        headers: requestHeaders(options.telemetry),
        body: JSON.stringify(credential),
      });
      if (!cleanupResponse.ok) throw await responseError(cleanupResponse, "The client session could not be cleaned up");
    },
  };
}

function requestHeaders(telemetry: TelemetryJourney | undefined): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(telemetry?.headers ?? {})) headers.set(name, value);
  return headers;
}

async function requireClientSessionResponse(response: Response): Promise<{
  readonly apiBaseURL: string;
  readonly syncURL: string;
  readonly clientSessionId: string;
  readonly inviteToken: string;
}> {
  if (!response.ok) throw await responseError(response, "The client session could not be created");
  const value = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!value || !isHttpURL(value.apiBaseURL) || !isWebSocketURL(value.syncURL) || !isCapability(value.clientSessionId) || !isCapability(value.inviteToken)) {
    throw new TypeError("The meeting broker returned an invalid client session");
  }
  return {
    apiBaseURL: value.apiBaseURL,
    syncURL: value.syncURL,
    clientSessionId: value.clientSessionId,
    inviteToken: value.inviteToken,
  };
}

async function responseError(response: Response, fallback: string): Promise<ClientSessionError> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { readonly error?: unknown } | null;
  return new ClientSessionError(response.status, typeof body?.error === "string" && body.error.trim() ? body.error : `${fallback} (HTTP ${response.status})`);
}

function normalizedBaseURL(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("brokerBaseURL must use HTTP or HTTPS");
  return url.toString().replace(/\/+$/u, "");
}

function meetingLink(baseURL: string, inviteToken: string): string {
  const url = new URL(baseURL);
  url.pathname = "/";
  url.search = "";
  url.hash = new URLSearchParams({ meeting: inviteToken }).toString();
  return url.toString();
}

function isHttpURL(value: unknown): value is string {
  return isURLWithProtocol(value, new Set(["http:", "https:"]));
}

function isWebSocketURL(value: unknown): value is string {
  return isURLWithProtocol(value, new Set(["ws:", "wss:"]));
}

function isURLWithProtocol(value: unknown, protocols: ReadonlySet<string>): value is string {
  if (typeof value !== "string") return false;
  try {
    return protocols.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isCapability(value: unknown): value is string {
  return typeof value === "string" && capabilityPattern.test(value);
}
