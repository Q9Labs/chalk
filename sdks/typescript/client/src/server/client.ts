import { ChalkAPIError } from "./errors.js";
import { createServerRequester } from "./transport.js";
import type {
  APIKeyList,
  APIKeyWithSecret,
  AdmitParticipantInput,
  ChalkServerClient,
  ChalkServerClientOptions,
  CreateAPIKeyInput,
  CreateRoomInput,
  CreateSessionInput,
  IssueParticipantAccessInput,
  ListAPIKeysInput,
  ParticipantAccess,
  ParticipantAdmission,
  ParticipantRemoval,
  RemoveParticipantInput,
  Room,
  RoomSession,
  EndSessionResult,
} from "./types.js";

export function createChalkServerClient(options: ChalkServerClientOptions): ChalkServerClient {
  const apiKey = required(options.apiKey, "apiKey");
  const tenantId = required(options.tenantId, "tenantId");
  const apiBaseURL = normalizedBaseURL(options.apiBaseURL);
  const fetchImplementation = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  if (typeof fetchImplementation !== "function") throw new TypeError("A fetch implementation is required");

  const tenantPath = `/v1/tenants/${segment(tenantId)}`;
  const request = createServerRequester(options, apiKey, apiBaseURL, fetchImplementation);

  return {
    rooms: {
      create: async (input) => roomFromSpace(await request<SpaceWire>({ method: "POST", path: `${tenantPath}/spaces`, body: createSpaceRequest(input), expectedStatus: 201, retry: "never" })),
    },
    sessions: {
      create: async (roomId, input, idempotency) => sessionFromEpisode(await request<EpisodeWire>({ method: "POST", path: `${tenantPath}/spaces/${segment(roomId)}/episodes`, body: createEpisodeRequest(input), expectedStatus: 201, idempotency, retry: "caller_idempotency" })),
      end: async (roomId, sessionId, idempotency) => endSession(await request<EndSessionWire>({ method: "POST", path: `${tenantPath}/spaces/${segment(roomId)}/episodes/${segment(sessionId)}/end`, expectedStatus: 202, idempotency, retry: "caller_idempotency" })),
    },
    participants: {
      admit: async (roomId, sessionId, input, idempotency) => {
        const lifecycle = await request<ParticipantAdmissionWire>({
          method: "POST",
          path: `${tenantPath}/spaces/${segment(roomId)}/episodes/${segment(sessionId)}/participants`,
          body: participantAdmissionRequest(input),
          expectedStatus: 201,
          idempotency,
          retry: "caller_idempotency",
        });
        return participantAdmission(lifecycle);
      },
      issueAccess: async (roomId, sessionId, participantId, input) => {
        const access = await request<ParticipantAccessWire>({
          method: "POST",
          path: `${tenantPath}/spaces/${segment(roomId)}/episodes/${segment(sessionId)}/participants/${segment(participantId)}/access-grant`,
          body: participantAccessRequest(input),
          expectedStatus: 201,
          retry: input.replaceMediaConnection === true ? "never" : "always",
        });
        return participantAccess(access);
      },
      remove: async (roomId, sessionId, participantId, input, idempotency) => {
        const removal = await request<ParticipantRemovalWire>({
          method: "POST",
          path: `${tenantPath}/spaces/${segment(roomId)}/episodes/${segment(sessionId)}/participants/${segment(participantId)}/remove`,
          body: participantRemovalRequest(input),
          expectedStatus: 202,
          idempotency,
          retry: "caller_idempotency",
        });
        return participantRemoval(removal);
      },
    },
    apiKeys: {
      create: (input) => request<APIKeyWithSecret>({ method: "POST", path: `${tenantPath}/api-keys`, body: apiKeyCreateRequest(input), expectedStatus: 201, retry: "never" }),
      list: (input) => request<APIKeyList>({ method: "GET", path: `${tenantPath}/api-keys${apiKeyQuery(input)}`, expectedStatus: 200, retry: "always" }),
      rotate: (apiKeyId, input) => request<APIKeyWithSecret>({ method: "POST", path: `${tenantPath}/api-keys/${segment(apiKeyId)}/rotate`, body: { expires_at: input?.expiresAt }, expectedStatus: 200, retry: "never" }),
      revoke: (apiKeyId) => request<void>({ method: "DELETE", path: `${tenantPath}/api-keys/${segment(apiKeyId)}`, expectedStatus: 204, retry: "always" }),
    },
  };
}

function createSpaceRequest(input: CreateRoomInput): Record<string, unknown> {
  return {
    media_plane: input.media_plane,
    name: input.name,
    slug: input.slug,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.recurring_policy === undefined ? {} : { recurring_policy: input.recurring_policy }),
  };
}

function createEpisodeRequest(input: CreateSessionInput): Record<string, unknown> {
  return {
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.started_at === undefined ? {} : { started_at: input.started_at }),
  };
}

function participantAdmissionRequest(input: AdmitParticipantInput): Record<string, unknown> {
  return {
    participant_id: input.participant_session_id,
    name: input.name,
    role: input.initial_role,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
}

function participantAccessRequest(input: IssueParticipantAccessInput): Record<string, unknown> {
  return {
    participant_generation: input.participantSessionGeneration,
    replace_media_connection: input.replaceMediaConnection ?? false,
    ...(input.currentMediaToken ? { current_media_token: input.currentMediaToken } : {}),
  };
}

function participantRemovalRequest(input: RemoveParticipantInput): Record<string, unknown> {
  return { participant_generation: input.participantSessionGeneration };
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
    readonly space_id?: string;
    readonly episode_id?: string;
    readonly participant_id?: string;
    readonly room_id?: string;
    readonly session_id?: string;
    readonly participant_session_id?: string;
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

type SpaceWire = {
  readonly created_at: string;
  readonly created_by_user_id: string | null;
  readonly id: string;
  readonly media_plane: string;
  readonly metadata: unknown;
  readonly name: string;
  readonly recurring_policy: unknown;
  readonly slug: string;
  readonly tenant_id: string;
  readonly updated_at: string;
};

type EpisodeWire = {
  readonly created_at: string;
  readonly created_by_user_id?: string | null;
  readonly ended_at?: string | null;
  readonly id: string;
  readonly metadata: unknown;
  readonly space_id: string;
  readonly started_at?: string | null;
  readonly status: string;
  readonly tenant_id: string;
  readonly updated_at: string;
};

type EndSessionWire = {
  readonly external_operation: NonNullable<ParticipantRemovalWire["external_operation"]>;
  readonly episode_id?: string;
  readonly session_id?: string;
  readonly status: string;
};

type ParticipantAdmissionWire = {
  readonly access?: ParticipantAccessWire | null;
  readonly admission_request?: { readonly expires_at: string; readonly id: string; readonly status: string } | null;
  readonly expires_at?: string;
  readonly lifecycle_intent: {
    readonly created_at: string;
    readonly id: string;
    readonly intent_name: string;
    readonly participant_generation?: number | null;
    readonly participant_id?: string | null;
    readonly participant_session_generation?: number | null;
    readonly participant_session_id?: string | null;
    readonly request_key: string;
    readonly status: string;
  };
  readonly media_plane?: { readonly client_payload: Readonly<Record<string, unknown>>; readonly provider: string } | null;
  readonly participant: {
    readonly generation: number;
    readonly id: string;
    readonly space_id?: string;
    readonly episode_id?: string;
    readonly room_id?: string;
    readonly session_id?: string;
    readonly status: string;
    readonly tenant_id: string;
  };
  readonly sync_token?: string;
};

type ParticipantRemovalWire = {
  readonly external_operation?: {
    readonly created_at: string;
    readonly deadline_generation?: number | null;
    readonly id: string;
    readonly operation_name: string;
    readonly request_key: string;
    readonly status: string;
    readonly target_participant_generation?: number | null;
    readonly target_participant_id?: string | null;
    readonly target_participant_session_generation?: number | null;
    readonly target_participant_session_id?: string | null;
  };
  readonly lifecycle_intent?: ParticipantAdmissionWire["lifecycle_intent"];
  readonly participant: ParticipantAdmissionWire["participant"];
};

function roomFromSpace(value: SpaceWire): Room {
  return {
    ...value,
    status: "active",
  };
}

function sessionFromEpisode(value: EpisodeWire): RoomSession {
  return {
    created_at: value.created_at,
    created_by_user_id: value.created_by_user_id ?? null,
    ended_at: value.ended_at ?? null,
    id: value.id,
    metadata: value.metadata,
    room_id: value.space_id,
    started_at: value.started_at ?? null,
    status: value.status as RoomSession["status"],
    tenant_id: value.tenant_id,
    updated_at: value.updated_at,
  };
}

function participantAdmission(value: ParticipantAdmissionWire): ParticipantAdmission {
  const { access, ...lifecycle } = value;
  const admission = {
    ...lifecycle,
    lifecycle_intent: lifecycleIntent(lifecycle.lifecycle_intent),
    participant: legacyParticipant(lifecycle.participant),
  };
  if (access === undefined) return admission;
  return { ...admission, access: access === null ? null : participantAccess(access) };
}

function participantAccess(value: ParticipantAccessWire): ParticipantAccess {
  const payload = cloudflareClientPayload(value.media);
  return {
    subject: {
      tenantId: value.subject.tenant_id,
      roomId: requiredResponseID(value.subject.space_id, value.subject.room_id),
      sessionId: requiredResponseID(value.subject.episode_id, value.subject.session_id),
      participantSessionId: requiredResponseID(value.subject.participant_id, value.subject.participant_session_id),
      participantGeneration: value.subject.participant_generation,
    },
    sync: { token: value.sync.token, expiresAt: value.sync.expires_at },
    media: {
      token: value.media.token,
      expiresAt: value.media.expires_at,
      provider: "cloudflare_sfu",
      clientPayload: payload,
    },
  };
}

function cloudflareClientPayload(media: ParticipantAccessWire["media"]): ParticipantAccess["media"]["clientPayload"] {
  const { connectionId, stunServer } = media.client_payload;
  if (media.provider !== "cloudflare_sfu" || typeof connectionId !== "string" || typeof stunServer !== "string") {
    throw invalidResponse(201);
  }
  return { connectionId, stunServer };
}

function requiredResponseID(canonical: string | undefined, legacy: string | undefined): string {
  const value = canonical ?? legacy;
  if (!value) throw invalidResponse(201);
  return value;
}

function invalidResponse(status: number): ChalkAPIError {
  return new ChalkAPIError({ code: "invalid_response", retryable: false, status });
}

function endSession(value: EndSessionWire): EndSessionResult {
  return {
    external_operation: {
      ...value.external_operation,
      target_participant_session_generation: value.external_operation.target_participant_session_generation ?? value.external_operation.target_participant_generation,
      target_participant_session_id: value.external_operation.target_participant_session_id ?? value.external_operation.target_participant_id,
    },
    session_id: value.session_id ?? value.episode_id ?? "",
    status: value.status,
  };
}

function participantRemoval(value: ParticipantRemovalWire): ParticipantRemoval {
  return {
    lifecycle_intent: removalIntent(value),
    participant: legacyParticipant(value.participant),
  };
}

function removalIntent(value: ParticipantRemovalWire): ParticipantRemoval["lifecycle_intent"] {
  if (value.lifecycle_intent) return lifecycleIntent(value.lifecycle_intent);
  const operation = value.external_operation;
  if (!operation) throw invalidResponse(202);
  return {
    created_at: operation.created_at,
    id: operation.id,
    intent_name: operation.operation_name,
    participant_session_generation: operation.target_participant_session_generation ?? operation.target_participant_generation ?? null,
    participant_session_id: operation.target_participant_session_id ?? operation.target_participant_id ?? null,
    request_key: operation.request_key,
    status: operation.status,
  };
}

function lifecycleIntent(intent: ParticipantAdmissionWire["lifecycle_intent"]): ParticipantAdmission["lifecycle_intent"] {
  return {
    ...intent,
    participant_session_generation: intent.participant_session_generation ?? intent.participant_generation ?? null,
    participant_session_id: intent.participant_session_id ?? intent.participant_id ?? null,
  };
}

function legacyParticipant(participant: ParticipantAdmissionWire["participant"]): ParticipantAdmission["participant"] {
  return {
    ...participant,
    room_id: participant.room_id ?? participant.space_id ?? "",
    session_id: participant.session_id ?? participant.episode_id ?? "",
  };
}
