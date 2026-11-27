import { parseAccessGrant } from "../access/grant.js";
import { accessRefreshInput } from "./access-refresh.js";
import { ChalkAPIError } from "./errors.js";
import type { ServerSchemas } from "./resource-types.js";
import { createServerRequester, type ServerRequest } from "./transport.js";
import type {
  APIKeyList,
  APIKeyWithSecret,
  AccessGrant,
  AdmitParticipantInput,
  ChalkServerClient,
  ChalkIdempotencyOptions,
  ChalkServerClientOptions,
  CreateSpaceInput,
  Episode,
  EpisodeEnd,
  IssueAccessGrantInput,
  ParticipantLifecycle,
  ParticipantRemoval,
  PublicAdmissionRequest,
  PublicAdmissionRequestPage,
  Recording,
  RecordingDownloadURL,
  RecordingExportRequestAcceptedResponse,
  RecordingList,
  Space,
  SpacePublicInvite,
  SpaceList,
} from "./types.js";
export function createChalkServerClient(options: ChalkServerClientOptions): ChalkServerClient {
  const apiKey = required(options.apiKey, "apiKey");
  const tenantId = required(options.tenantId, "tenantId");
  const apiBaseURL = normalizedBaseURL(options.apiBaseURL);
  const fetchImplementation = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  if (typeof fetchImplementation !== "function") throw new TypeError("A fetch implementation is required");
  const request = createServerRequester(options, apiKey, apiBaseURL, fetchImplementation);
  const tenantPath = `/v1/tenants/${segment(tenantId)}`;
  const spacePath = (spaceId: string) => `${tenantPath}/spaces/${segment(spaceId)}`;
  const episodePath = (spaceId: string, episodeId: string) => `${spacePath(spaceId)}/episodes/${segment(episodeId)}`;
  const participantPath = (spaceId: string, episodeId: string, participantId: string) => `${episodePath(spaceId, episodeId)}/participants/${segment(participantId)}`;
  const recordingPath = (recordingId: string) => `${tenantPath}/recordings/${segment(recordingId)}`;
  const transcriptPath = (transcriptId: string) => `${tenantPath}/transcripts/${segment(transcriptId)}`;
  const scheduledEpisodePath = (spaceId: string, id: string) => `${spacePath(spaceId)}/scheduled-episodes/${segment(id)}`;
  const webhookEndpointsPath = `${tenantPath}/webhook-endpoints`;
  const webhookEndpointPath = (endpointId: string) => `${webhookEndpointsPath}/${segment(endpointId)}`;
  const apiKeyPath = (apiKeyId: string) => `${tenantPath}/api-keys/${segment(apiKeyId)}`;
  const admissionRequestPath = (spaceId: string, requestHandle: string) => `${spacePath(spaceId)}/public-admission-requests/${segment(requestHandle)}`;
  // Reads and idempotent writes retry on their own; `post` retries only when the caller supplies an idempotency key.
  const send = <T>(method: ServerRequest["method"], path: string, expectedStatus: number, body?: unknown) => request<T>({ method, path, body, expectedStatus, retry: "always" });
  const post = <T>(path: string, expectedStatus: number, idempotency: ChalkIdempotencyOptions | undefined, body?: unknown) => request<T>({ method: "POST", path, body, expectedStatus, idempotency, retry: "caller_idempotency" });
  const writeWebhook = <T>(method: "PATCH" | "DELETE", endpointId: string, revision: number, expectedStatus: number, idempotency: ChalkIdempotencyOptions | undefined, body?: unknown) =>
    request<T>({ method, path: webhookEndpointPath(endpointId), body, expectedStatus, headers: { "If-Match": `"${revision}"` }, idempotency, retry: "caller_idempotency" });
  return {
    spaces: {
      archive: (spaceId) => send<Space>("POST", `${spacePath(spaceId)}/archive`, 200),
      create: (input, idempotency) => post<Space>(`${tenantPath}/spaces`, 201, idempotency, createSpaceRequest(input)),
      get: (spaceId) => send<Space>("GET", spacePath(spaceId), 200),
      list: (input) => send<SpaceList>("GET", `${tenantPath}/spaces${query({ archived: input?.archived, cursor: input?.cursor, page_size: input?.pageSize })}`, 200),
      restore: (spaceId) => send<Space>("POST", `${spacePath(spaceId)}/restore`, 200),
      update: (spaceId, input) => send<Space>("PATCH", spacePath(spaceId), 200, { metadata: input.metadata, recording_policy: input.recordingPolicy, transcription_policy: input.transcriptionPolicy } satisfies ServerSchemas["UpdateSpaceRequest"]),
    },
    episodes: {
      create: (spaceId, input, idempotency) => post<Episode>(`${spacePath(spaceId)}/episodes`, 201, idempotency, { metadata: input.metadata, started_at: input.startedAt }),
      end: (spaceId, episodeId, idempotency) => post<EpisodeEnd>(`${episodePath(spaceId, episodeId)}/end`, 202, idempotency),
    },
    scheduledEpisodes: {
      put: (spaceId, id, input) =>
        send("PUT", scheduledEpisodePath(spaceId, id), 200, {
          starts_at: input.startsAt,
          expected_ends_at: input.expectedEndsAt,
          expected_participants: input.expectedParticipants?.map(({ identityExternalId, name, role }) => ({ identity_external_id: identityExternalId, name, role })),
          metadata: input.metadata,
        } satisfies ServerSchemas["PutScheduledEpisodeRequest"]),
      get: (spaceId, id) => send("GET", scheduledEpisodePath(spaceId, id), 200),
      delete: (spaceId, id) => send("DELETE", scheduledEpisodePath(spaceId, id), 204),
    },
    participants: {
      admit: async (spaceId, episodeId, input, idempotency) => {
        const lifecycle = await post<ParticipantLifecycleWire>(`${episodePath(spaceId, episodeId)}/participants`, 201, idempotency, participantAdmissionRequest(input));
        return participantLifecycle(lifecycle);
      },
      issueAccess: async (spaceId, episodeId, participantId, input, refreshRequest) => {
        const access = await request<AccessGrantWire>({
          method: "POST",
          path: `${participantPath(spaceId, episodeId, participantId)}/access-grant`,
          body: accessGrantRequest(accessRefreshInput(input, refreshRequest)),
          expectedStatus: 201,
          // An expired token can cause replacement even without the explicit flag.
          retry: "never",
        });
        return accessGrant(access);
      },
      remove: (spaceId, episodeId, participantId, input, idempotency) => post<ParticipantRemoval>(`${participantPath(spaceId, episodeId, participantId)}/remove`, 202, idempotency, { participant_generation: input.participantGeneration }),
    },
    apiKeys: {
      create: (input) => post<APIKeyWithSecret>(`${tenantPath}/api-keys`, 201, undefined, { expires_at: input.expiresAt, name: input.name, scopes: [...input.scopes] }),
      list: (input) => send<APIKeyList>("GET", `${tenantPath}/api-keys${query({ cursor: input?.cursor, page_size: input?.pageSize })}`, 200),
      rotate: (apiKeyId, input) => post<APIKeyWithSecret>(`${apiKeyPath(apiKeyId)}/rotate`, 200, undefined, { expires_at: input?.expiresAt }),
      revoke: (apiKeyId) => send<void>("DELETE", apiKeyPath(apiKeyId), 204),
    },
    recordings: {
      list: (input) => send<RecordingList>("GET", `${tenantPath}/recordings${query({ cursor: input?.cursor, episode_id: input?.episodeId, page_size: input?.pageSize, space_id: input?.spaceId })}`, 200),
      get: (recordingId) => send<Recording>("GET", recordingPath(recordingId), 200),
      requestExport: (recordingId) => send<RecordingExportRequestAcceptedResponse>("POST", `${recordingPath(recordingId)}/export`, 202, {}),
      createDownloadURL: (recordingId, input) => send<RecordingDownloadURL>("POST", `${recordingPath(recordingId)}/download-url`, 200, { expires_in_seconds: input.expiresInSeconds, download: input.download }),
    },
    transcripts: {
      list: (input) => send("GET", `${tenantPath}/transcripts${query({ cursor: input?.cursor, page_size: input?.pageSize, recording_id: input?.recordingId })}`, 200),
      get: (id) => send("GET", transcriptPath(id), 200),
      getDocument: (id) => send("GET", `${transcriptPath(id)}/document`, 200),
      getText: (id) => request({ method: "GET", path: `${transcriptPath(id)}/text`, expectedStatus: 200, response: "text", retry: "always" }),
      createDownloadURL: (id, input) => send("POST", `${transcriptPath(id)}/download-url`, 200, { expires_in_seconds: input.expiresInSeconds } satisfies ServerSchemas["CreateTranscriptDownloadURLRequest"]),
      request: (recordingId, input) => send("POST", `${recordingPath(recordingId)}/transcripts`, 202, { idempotency_key: input.idempotencyKey, language: input.language, languages: input.languages?.slice() } satisfies ServerSchemas["RequestTranscriptRequest"]),
      delete: (id) => send("DELETE", transcriptPath(id), 204),
    },
    webhookEndpoints: {
      create: (input, idempotency) => post(webhookEndpointsPath, 201, idempotency, { api_version: input.apiVersion, enabled: input.enabled, event_types: [...input.eventTypes], name: input.name, url: input.url } satisfies ServerSchemas["CreateWebhookEndpointRequest"]),
      list: (input) => send("GET", `${webhookEndpointsPath}${query({ cursor: input?.cursor, page_size: input?.pageSize })}`, 200),
      get: (id) => send("GET", webhookEndpointPath(id), 200),
      update: (id, input, idempotency) => writeWebhook("PATCH", id, input.revision, 200, idempotency, { api_version: input.apiVersion, enabled: input.enabled, event_types: input.eventTypes?.slice(), name: input.name, url: input.url } satisfies ServerSchemas["UpdateWebhookEndpointRequest"]),
      rotateSecret: (id, input, idempotency) => post(`${webhookEndpointPath(id)}/rotate-secret`, 200, idempotency, { revoke_previous_immediately: input.revokePreviousImmediately } satisfies ServerSchemas["RotateWebhookSecretRequest"]),
      delete: (id, revision, idempotency) => writeWebhook("DELETE", id, revision, 204, idempotency),
      listDeliveries: (id, input) => send("GET", `${webhookEndpointPath(id)}/deliveries${query({ cursor: input?.cursor, page_size: input?.pageSize, state: input?.states, event_type: input?.eventTypes })}`, 200),
      redeliver: (id, deliveryId, idempotency) => post(`${webhookEndpointPath(id)}/deliveries/${segment(deliveryId)}/redeliver`, 201, idempotency),
    },
    publicInvites: {
      get: (spaceId) => send<SpacePublicInvite>("GET", `${spacePath(spaceId)}/public-invite`, 200),
      update: (spaceId, input) => send<SpacePublicInvite>("PATCH", `${spacePath(spaceId)}/public-invite`, 200, { enabled: input.enabled }),
      rotate: (spaceId, idempotency) => post<SpacePublicInvite>(`${spacePath(spaceId)}/public-invite/rotations`, 201, idempotency),
    },
    publicAdmissionRequests: {
      list: (spaceId, input) => send<PublicAdmissionRequestPage>("GET", `${spacePath(spaceId)}/public-admission-requests${query({ state: input?.state })}`, 200),
      approve: (spaceId, requestHandle, idempotency) => post<PublicAdmissionRequest>(`${admissionRequestPath(spaceId, requestHandle)}/approval`, 200, idempotency),
      deny: (spaceId, requestHandle, idempotency) => post<PublicAdmissionRequest>(`${admissionRequestPath(spaceId, requestHandle)}/denial`, 200, idempotency),
    },
  };
}
function createSpaceRequest(input: CreateSpaceInput) {
  return {
    default_episode_duration_seconds: input.defaultEpisodeDurationSeconds,
    linger_window_seconds: input.lingerWindowSeconds,
    maximum_episode_duration_seconds: input.maximumEpisodeDurationSeconds,
    media_plane: input.mediaPlane,
    name: input.name,
    slug: input.slug,
    admission_policy: input.admissionPolicy,
    metadata: input.metadata,
    recording_policy: input.recordingPolicy,
    recurring_policy: input.recurringPolicy,
    transcription_policy: input.transcriptionPolicy,
  };
}
function participantAdmissionRequest(input: AdmitParticipantInput) {
  return {
    admission: input.admission,
    name: input.name,
    role: input.role,
    identity_id: input.identityId,
    identity_external_id: input.identityExternalId,
    metadata: input.metadata,
    participant_id: input.participantId,
  };
}
function accessGrantRequest(input: IssueAccessGrantInput): Record<string, unknown> {
  return {
    participant_generation: input.participantGeneration,
    replace_media_connection: input.replaceMediaConnection ?? false,
    ...(input.currentMediaToken ? { current_media_token: input.currentMediaToken } : {}),
    ...(input.replaceMediaConnection && input.expectedMediaConnectionId !== undefined ? { expected_media_connection_id: input.expectedMediaConnectionId } : {}),
  };
}
// Undefined values are skipped, so a filter the caller left out never reaches the URL.
function query(params: Readonly<Record<string, boolean | number | string | readonly string[] | undefined>>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value === "object") {
      for (const item of value) search.append(name, item);
    } else {
      search.set(name, String(value));
    }
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
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
  readonly episode_started_at?: string | null;
  readonly subject: {
    readonly tenant_id: string;
    readonly space_id: string;
    readonly episode_id: string;
    readonly participant_id: string;
    readonly participant_generation: number;
  };
  readonly sync: {
    readonly token: string;
    readonly expires_at: string;
  };
  readonly media: {
    readonly token: string;
    readonly expires_at: string;
    readonly provider: string;
    readonly client_payload: Record<string, unknown>;
  };
  readonly diagnostics?: {
    readonly token: string;
    readonly expires_at: string;
    readonly generation: number;
    readonly intake_path: string;
  } | null;
  readonly telemetry?: { readonly token: string; readonly expires_at: string };
};
type ParticipantLifecycleWire = Omit<ParticipantLifecycle, "access"> & {
  readonly access?: AccessGrantWire | null;
};
function participantLifecycle(value: ParticipantLifecycleWire): ParticipantLifecycle {
  const { access, ...lifecycle } = value;
  if (access === undefined) return lifecycle;
  return { ...lifecycle, access: access === null ? null : accessGrant(access) };
}
function accessGrant(value: AccessGrantWire): AccessGrant {
  const payload = mediaClientPayload(value.media);
  return parseAccessGrant({
    episode_started_at: value.episode_started_at,
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
      provider: value.media.provider,
      client_payload: payload,
    },
    telemetry: value.telemetry,
  });
}
function mediaClientPayload(media: AccessGrantWire["media"]): Readonly<Record<string, unknown>> {
  if (media.provider !== "chalk_sfu") throw invalidResponse(201);
  return chalkSFUClientPayload(media.client_payload);
}
function chalkSFUClientPayload({ connectionId, episodeRef, iceServers, capabilities }: AccessGrantWire["media"]["client_payload"]): Readonly<Record<string, unknown>> {
  if (typeof connectionId !== "string" || typeof episodeRef !== "string") throw invalidResponse(201);
  return { connectionId, episodeRef, iceServers: iceServers ?? [], capabilities: capabilities ?? {} };
}
function requiredResponseID(value: string | undefined): string {
  if (!value) throw invalidResponse(201);
  return value;
}
function invalidResponse(status: number): ChalkAPIError {
  return new ChalkAPIError({ code: "invalid_response", retryable: false, status });
}
