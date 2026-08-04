import { parseAccessGrant } from "../access/grant.js";
import { ChalkAPIError } from "./errors.js";
import { createServerRequester } from "./transport.js";
import type {
  APIKeyList,
  APIKeyWithSecret,
  AccessGrant,
  AdmitParticipantInput,
  ChalkServerClient,
  ChalkServerClientOptions,
  CreateAPIKeyInput,
  CreateEpisodeInput,
  CreateSpaceInput,
  Episode,
  EpisodeEnd,
  IssueAccessGrantInput,
  ListAPIKeysInput,
  ParticipantLifecycle,
  ParticipantRemoval,
  RemoveParticipantInput,
  Space,
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
    spaces: {
      create: (input) => request<Space>({ method: "POST", path: `${tenantPath}/spaces`, body: createSpaceRequest(input), expectedStatus: 201, retry: "never" }),
    },
    episodes: {
      create: (spaceId, input, idempotency) => request<Episode>({ method: "POST", path: `${tenantPath}/spaces/${segment(spaceId)}/episodes`, body: createEpisodeRequest(input), expectedStatus: 201, idempotency, retry: "caller_idempotency" }),
      end: (spaceId, episodeId, idempotency) => request<EpisodeEnd>({ method: "POST", path: `${tenantPath}/spaces/${segment(spaceId)}/episodes/${segment(episodeId)}/end`, expectedStatus: 202, idempotency, retry: "caller_idempotency" }),
    },
    participants: {
      admit: async (spaceId, episodeId, input, idempotency) => {
        const lifecycle = await request<ParticipantLifecycleWire>({
          method: "POST",
          path: `${tenantPath}/spaces/${segment(spaceId)}/episodes/${segment(episodeId)}/participants`,
          body: participantAdmissionRequest(input),
          expectedStatus: 201,
          idempotency,
          retry: "caller_idempotency",
        });
        return participantLifecycle(lifecycle);
      },
      issueAccess: async (spaceId, episodeId, participantId, input) => {
        const access = await request<AccessGrantWire>({
          method: "POST",
          path: `${tenantPath}/spaces/${segment(spaceId)}/episodes/${segment(episodeId)}/participants/${segment(participantId)}/access-grant`,
          body: accessGrantRequest(input),
          expectedStatus: 201,
          retry: input.replaceMediaConnection === true ? "never" : "always",
        });
        return accessGrant(access);
      },
      remove: (spaceId, episodeId, participantId, input, idempotency) =>
        request<ParticipantRemoval>({
          method: "POST",
          path: `${tenantPath}/spaces/${segment(spaceId)}/episodes/${segment(episodeId)}/participants/${segment(participantId)}/remove`,
          body: participantRemovalRequest(input),
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

function createSpaceRequest(input: CreateSpaceInput): Record<string, unknown> {
  return {
    default_episode_duration_seconds: input.defaultEpisodeDurationSeconds,
    linger_window_seconds: input.lingerWindowSeconds,
    maximum_episode_duration_seconds: input.maximumEpisodeDurationSeconds,
    media_plane: input.mediaPlane,
    name: input.name,
    slug: input.slug,
    ...(input.admissionPolicy === undefined ? {} : { admission_policy: input.admissionPolicy }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.recurringPolicy === undefined ? {} : { recurring_policy: input.recurringPolicy }),
  };
}

function createEpisodeRequest(input: CreateEpisodeInput): Record<string, unknown> {
  return {
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.startedAt === undefined ? {} : { started_at: input.startedAt }),
  };
}

function participantAdmissionRequest(input: AdmitParticipantInput): Record<string, unknown> {
  return {
    name: input.name,
    role: input.role,
    ...(input.identityId === undefined ? {} : { identity_id: input.identityId }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.participantId === undefined ? {} : { participant_id: input.participantId }),
  };
}

function accessGrantRequest(input: IssueAccessGrantInput): Record<string, unknown> {
  return {
    participant_generation: input.participantGeneration,
    replace_media_connection: input.replaceMediaConnection ?? false,
    ...(input.currentMediaToken ? { current_media_token: input.currentMediaToken } : {}),
  };
}

function participantRemovalRequest(input: RemoveParticipantInput): Record<string, unknown> {
  return { participant_generation: input.participantGeneration };
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

type AccessGrantWire = {
  readonly subject: {
    readonly tenant_id: string;
    readonly space_id: string;
    readonly episode_id: string;
    readonly participant_id: string;
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

type ParticipantLifecycleWire = Omit<ParticipantLifecycle, "access"> & { readonly access?: AccessGrantWire | null };

function participantLifecycle(value: ParticipantLifecycleWire): ParticipantLifecycle {
  const { access, ...lifecycle } = value;
  if (access === undefined) return lifecycle;
  return { ...lifecycle, access: access === null ? null : accessGrant(access) };
}

function accessGrant(value: AccessGrantWire): AccessGrant {
  const payload = cloudflareClientPayload(value.media);
  return parseAccessGrant({
    subject: {
      tenant_id: value.subject.tenant_id,
      space_id: requiredResponseID(value.subject.space_id),
      episode_id: requiredResponseID(value.subject.episode_id),
      participant_id: requiredResponseID(value.subject.participant_id),
      participant_generation: value.subject.participant_generation,
    },
    sync: value.sync,
    media: {
      token: value.media.token,
      expires_at: value.media.expires_at,
      provider: "cloudflare_sfu",
      client_payload: payload,
    },
  });
}

function cloudflareClientPayload(media: AccessGrantWire["media"]): { readonly connectionId: string; readonly stunServer: string } {
  const { connectionId, stunServer } = media.client_payload;
  if (media.provider !== "cloudflare_sfu" || typeof connectionId !== "string" || typeof stunServer !== "string") {
    throw invalidResponse(201);
  }
  return { connectionId, stunServer };
}

function requiredResponseID(value: string | undefined): string {
  if (!value) throw invalidResponse(201);
  return value;
}

function invalidResponse(status: number): ChalkAPIError {
  return new ChalkAPIError({ code: "invalid_response", retryable: false, status });
}
