import { ChalkAPIError } from "./errors.js";
import { createServerRequester } from "./transport.js";
import type { APIKeyList, APIKeyWithSecret, ChalkServerClient, ChalkServerClientOptions, CreateAPIKeyInput, IssueParticipantAccessInput, ListAPIKeysInput, ParticipantAccess, ParticipantAdmission, ParticipantRemoval } from "./types.js";

export function createChalkServerClient(options: ChalkServerClientOptions): ChalkServerClient {
  const apiKey = required(options.apiKey, "apiKey");
  const tenantId = required(options.tenantId, "tenantId");
  const apiBaseURL = normalizedBaseURL(options.apiBaseURL);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") throw new TypeError("A fetch implementation is required");

  const tenantPath = `/v1/tenants/${segment(tenantId)}`;
  const request = createServerRequester(options, apiKey, apiBaseURL, fetchImplementation);

  return {
    rooms: {
      create: (input) => request({ method: "POST", path: `${tenantPath}/rooms`, body: input, expectedStatus: 201, retry: "never" }),
    },
    sessions: {
      create: (roomId, input, idempotency) => request({ method: "POST", path: `${tenantPath}/rooms/${segment(roomId)}/sessions`, body: input, expectedStatus: 201, idempotency, retry: "caller_idempotency" }),
      end: (roomId, sessionId, idempotency) => request({ method: "POST", path: `${tenantPath}/rooms/${segment(roomId)}/sessions/${segment(sessionId)}/end`, expectedStatus: 202, idempotency, retry: "caller_idempotency" }),
    },
    participants: {
      admit: async (roomId, sessionId, input, idempotency) => {
        const lifecycle = await request<ParticipantAdmissionWire>({
          method: "POST",
          path: `${tenantPath}/rooms/${segment(roomId)}/sessions/${segment(sessionId)}/participants`,
          body: input,
          expectedStatus: 201,
          idempotency,
          retry: "caller_idempotency",
        });
        return participantAdmission(lifecycle);
      },
      issueAccess: async (roomId, sessionId, participantSessionId, input) => {
        const access = await request<ParticipantAccessWire>({
          method: "POST",
          path: `${tenantPath}/rooms/${segment(roomId)}/sessions/${segment(sessionId)}/participants/${segment(participantSessionId)}/access`,
          body: participantAccessRequest(input),
          expectedStatus: 201,
          retry: input.replaceMediaConnection === true ? "never" : "always",
        });
        return participantAccess(access);
      },
      remove: (roomId, sessionId, participantSessionId, input, idempotency) =>
        request<ParticipantRemoval>({
          method: "POST",
          path: `${tenantPath}/rooms/${segment(roomId)}/sessions/${segment(sessionId)}/participants/${segment(participantSessionId)}/remove`,
          body: { participant_session_generation: input.participantSessionGeneration },
          expectedStatus: 202,
          idempotency,
          retry: "caller_idempotency",
        }),
    },
    apiKeys: {
      create: (input) => request<APIKeyWithSecret>({ method: "POST", path: `${tenantPath}/api-keys`, body: apiKeyCreateRequest(input), expectedStatus: 201, retry: "never" }),
      list: (input) => request<APIKeyList>({ method: "GET", path: `${tenantPath}/api-keys${apiKeyQuery(input)}`, expectedStatus: 200, retry: "always" }),
      rotate: (apiKeyId, input) => request<APIKeyWithSecret>({ method: "POST", path: `${tenantPath}/api-keys/${segment(apiKeyId)}/rotate`, body: { expires_at: input?.expiresAt }, expectedStatus: 200, retry: "never" }),
      revoke: (apiKeyId) => request<void>({ method: "DELETE", path: `${tenantPath}/api-keys/${segment(apiKeyId)}`, expectedStatus: 204, retry: "always" }),
    },
  };
}

function participantAccessRequest(input: IssueParticipantAccessInput): Record<string, unknown> {
  return {
    participant_session_generation: input.participantSessionGeneration,
    replace_media_connection: input.replaceMediaConnection ?? false,
    ...(input.currentMediaToken ? { current_media_token: input.currentMediaToken } : {}),
  };
}

function apiKeyCreateRequest(input: CreateAPIKeyInput): Record<string, unknown> {
  return { expires_at: input.expiresAt, name: input.name, scopes: [...input.scopes] };
}

function apiKeyQuery(input: ListAPIKeysInput | undefined): string {
  const query = new URLSearchParams();
  setQueryValue(query, "cursor", input?.cursor);
  setQueryValue(query, "page_size", input?.pageSize);
  return prefixedQuery(query.toString());
}

function setQueryValue(query: URLSearchParams, name: string, value: number | string | undefined): void {
  if (value !== undefined) query.set(name, String(value));
}

function prefixedQuery(value: string): string {
  if (value === "") return "";
  return `?${value}`;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function normalizedBaseURL(value: string | URL): string {
  const url = new URL(value);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function segment(value: string): string {
  return encodeURIComponent(required(value, "identifier"));
}

type ParticipantAccessWire = {
  readonly subject: {
    readonly tenant_id: string;
    readonly room_id: string;
    readonly session_id: string;
    readonly participant_session_id: string;
    readonly participant_generation: number;
  };
  readonly sync: { readonly token: string; readonly expires_at: string };
  readonly media: {
    readonly token: string;
    readonly expires_at: string;
    readonly provider: string;
    readonly client_payload: Record<string, unknown>;
  };
};

type ParticipantAdmissionWire = Omit<ParticipantAdmission, "access"> & { readonly access?: ParticipantAccessWire | null };

function participantAdmission(value: ParticipantAdmissionWire): ParticipantAdmission {
  const { access, ...lifecycle } = value;
  return { ...lifecycle, ...(access === undefined ? {} : { access: access === null ? null : participantAccess(access) }) };
}

function participantAccess(value: ParticipantAccessWire): ParticipantAccess {
  const payload = value.media.client_payload;
  if (value.media.provider !== "cloudflare_sfu" || typeof payload.connectionId !== "string" || typeof payload.stunServer !== "string") {
    throw new ChalkAPIError({ code: "invalid_response", retryable: false, status: 201 });
  }
  return {
    subject: {
      tenantId: value.subject.tenant_id,
      roomId: value.subject.room_id,
      sessionId: value.subject.session_id,
      participantSessionId: value.subject.participant_session_id,
      participantGeneration: value.subject.participant_generation,
    },
    sync: { token: value.sync.token, expiresAt: value.sync.expires_at },
    media: {
      token: value.media.token,
      expiresAt: value.media.expires_at,
      provider: value.media.provider,
      clientPayload: { connectionId: payload.connectionId, stunServer: payload.stunServer },
    },
  };
}
