import { parseAccessGrant } from "../access/grant.js";
import { accessRefreshInput } from "./access-refresh.js";
import { ChalkAPIError } from "./errors.js";
import { createServerRequester } from "./transport.js";
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
  const apiKeyPath = (apiKeyId: string) => `${tenantPath}/api-keys/${segment(apiKeyId)}`;
  const admissionRequestPath = (spaceId: string, requestHandle: string) => `${spacePath(spaceId)}/public-admission-requests/${segment(requestHandle)}`;
  // Reads and idempotent writes retry on their own; `post` retries only when the caller supplies an idempotency key.
  const send = <T>(method: "DELETE" | "GET" | "PATCH" | "POST", path: string, expectedStatus: number, body?: unknown) => request<T>({ method, path, body, expectedStatus, retry: "always" });
  const post = <T>(path: string, expectedStatus: number, idempotency: ChalkIdempotencyOptions | undefined, body?: unknown) =>
    request<T>({ method: "POST", path, body, expectedStatus, idempotency, retry: "caller_idempotency" });
  return {
    spaces: {
      archive: (spaceId) => send<Space>("POST", `${spacePath(spaceId)}/archive`, 200),
      create: (input, idempotency) => post<Space>(`${tenantPath}/spaces`, 201, idempotency, createSpaceRequest(input)),
      get: (spaceId) => send<Space>("GET", spacePath(spaceId), 200),
      list: (input) => send<SpaceList>("GET", `${tenantPath}/spaces${query({ archived: input?.archived, cursor: input?.cursor, page_size: input?.pageSize })}`, 200),
      restore: (spaceId) => send<Space>("POST", `${spacePath(spaceId)}/restore`, 200),
      update: (spaceId, input) => send<Space>("PATCH", spacePath(spaceId), 200, { recording_policy: input.recordingPolicy, transcription_policy: input.transcriptionPolicy }),
    },
    episodes: {
      create: (spaceId, input, idempotency) => post<Episode>(`${spacePath(spaceId)}/episodes`, 201, idempotency, { metadata: input.metadata, started_at: input.startedAt }),
      end: (spaceId, episodeId, idempotency) => post<EpisodeEnd>(`${episodePath(spaceId, episodeId)}/end`, 202, idempotency),
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
      remove: (spaceId, episodeId, participantId, input, idempotency) =>
        post<ParticipantRemoval>(`${participantPath(spaceId, episodeId, participantId)}/remove`, 202, idempotency, { participant_generation: input.participantGeneration }),
    },
    apiKeys: {
      create: (input) => post<APIKeyWithSecret>(`${tenantPath}/api-keys`, 201, undefined, { expires_at: input.expiresAt, name: input.name, scopes: [...input.scopes] }),
      list: (input) => send<APIKeyList>("GET", `${tenantPath}/api-keys${query({ cursor: input?.cursor, page_size: input?.pageSize })}`, 200),
      rotate: (apiKeyId, input) => post<APIKeyWithSecret>(`${apiKeyPath(apiKeyId)}/rotate`, 200, undefined, { expires_at: input?.expiresAt }),
      revoke: (apiKeyId) => send<void>("DELETE", apiKeyPath(apiKeyId), 204),
    },
    recordings: {
      list: (input) =>
        send<RecordingList>("GET", `${tenantPath}/recordings${query({ cursor: input?.cursor, episode_id: input?.episodeId, page_size: input?.pageSize, space_id: input?.spaceId })}`, 200),
      get: (recordingId) => send<Recording>("GET", recordingPath(recordingId), 200),
      requestExport: (recordingId) => send<RecordingExportRequestAcceptedResponse>("POST", `${recordingPath(recordingId)}/export`, 202, {}),
      createDownloadURL: (recordingId, input) =>
        send<RecordingDownloadURL>("POST", `${recordingPath(recordingId)}/download-url`, 200, { expires_in_seconds: input.expiresInSeconds, download: input.download }),
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
function query(params: Readonly<Record<string, boolean | number | string | undefined>>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, String(value));
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
  });
}
function mediaClientPayload(media: AccessGrantWire["media"]): Readonly<Record<string, unknown>> {
  switch (media.provider) {
    case "cloudflare_sfu":
      return cloudflareSFUClientPayload(media.client_payload);
    case "chalk_sfu":
      return chalkSFUClientPayload(media.client_payload);
    default:
      throw invalidResponse(201);
  }
}
function cloudflareSFUClientPayload({ connectionId, stunServer, iceServers }: AccessGrantWire["media"]["client_payload"]): Readonly<Record<string, unknown>> {
  if (typeof connectionId !== "string" || typeof stunServer !== "string") throw invalidResponse(201);
  return { connectionId, stunServer, ...(iceServers === undefined ? {} : { iceServers }) };
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
