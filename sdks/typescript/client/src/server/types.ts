import type { components } from "../generated/openapi-types";
import type { AccessRefreshRequest } from "./access-refresh.js";
import type { AccessGrant } from "../access/grant.js";
export type { AccessGrant } from "../access/grant.js";
import type { APIKeyList, APIKeyWithSecret, CreateAPIKeyInput, ListAPIKeysInput, RotateAPIKeyInput } from "./api-key-types.js";
export type * from "./api-key-types.js";
export type ChalkServerHeaders = Readonly<Record<string, string>>;
export type ChalkServerClientOptions = {
  readonly apiKey: string;
  readonly tenantId: string;
  readonly apiBaseURL: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: ChalkServerHeaders;
};
export type ChalkIdempotencyOptions = {
  readonly idempotencyKey?: string;
};
export type RecordingPolicy = "disabled" | "manual" | "automatic";
export type TranscriptionPolicy = "disabled" | "on_demand" | "automatic";
export type CreateSpaceInput = {
  readonly admissionPolicy?: unknown;
  readonly defaultEpisodeDurationSeconds: number;
  readonly lingerWindowSeconds: number;
  readonly maximumEpisodeDurationSeconds: number;
  readonly mediaPlane?: "chalk_sfu";
  readonly metadata?: unknown;
  readonly name: string;
  readonly recordingPolicy?: RecordingPolicy;
  readonly recurringPolicy?: unknown;
  readonly slug: string;
  readonly transcriptionPolicy?: TranscriptionPolicy;
};
export type UpdateSpaceInput = {
  readonly metadata?: unknown;
  readonly recordingPolicy?: RecordingPolicy;
  readonly transcriptionPolicy?: TranscriptionPolicy;
};
export type Space = {
  readonly admission_policy: unknown;
  readonly archived: boolean;
  readonly archived_at?: string;
  readonly created_at: string;
  readonly created_by_user_id: string | null;
  readonly default_episode_duration_seconds: number;
  readonly id: string;
  readonly linger_window_seconds: number;
  readonly maximum_episode_duration_seconds: number;
  readonly media_plane: string;
  /** The Space's own plane; null means it inherits the Tenant or deployment default. */
  readonly media_plane_setting: string | null;
  /** The plane a new Episode would start on, before client capability and node room. Read-only. */
  readonly effective_media_plane: string | null;
  readonly metadata: unknown;
  readonly name: string;
  readonly recording_policy: RecordingPolicy;
  readonly recurring_policy: unknown;
  readonly roles: readonly {
    readonly capabilities: readonly string[];
    readonly id: string;
    readonly name: string;
  }[];
  readonly slug: string;
  readonly tenant_id: string;
  readonly transcription_policy: TranscriptionPolicy;
  readonly updated_at: string;
};
export type Pagination = {
  readonly has_more: boolean;
  readonly next_cursor: string | null;
  readonly page_size: number;
};
export type SpaceList = {
  readonly spaces: readonly Space[];
  readonly pagination: Pagination;
};
export type ListSpacesInput = {
  readonly archived?: boolean;
  readonly cursor?: string;
  readonly pageSize?: number;
};
export type CreateEpisodeInput = {
  readonly metadata?: unknown;
  readonly startedAt?: string | null;
};
export type Episode = {
  readonly config_snapshot: unknown;
  readonly created_at: string;
  readonly deadline_at: string;
  readonly deadline_generation: number;
  readonly end_reason?: string | null;
  readonly ended_at?: string;
  readonly id: string;
  readonly metadata: unknown;
  readonly space_id: string;
  readonly started_at: string;
  readonly status: "active" | "ending" | "ended";
  readonly tenant_id: string;
  readonly updated_at: string;
};
type ExternalOperation = {
  readonly created_at: string;
  readonly deadline_generation?: number | null;
  readonly id: string;
  readonly operation_name: string;
  readonly request_key: string;
  readonly status: string;
  readonly target_participant_generation?: number | null;
  readonly target_participant_id?: string | null;
};
export type EpisodeEnd = {
  readonly episode_id: string;
  /** Absent when the Episode was already ending or had ended, so no end operation was needed. */
  readonly external_operation?: ExternalOperation;
  readonly status: string;
};
export type AdmitParticipantInput = {
  readonly admission?: "direct" | "policy";
  /** Stable person key scoped to this tenant. Mutually exclusive with identityId. */
  readonly identityExternalId?: string;
  readonly identityId?: string;
  readonly metadata?: unknown;
  readonly name: string;
  readonly participantId?: string;
  readonly role: string;
};
type Participant = {
  readonly capabilities: readonly string[];
  readonly episode_id: string;
  readonly generation: number;
  readonly id: string;
  readonly identity_id?: string | null;
  readonly role: string;
  readonly space_id: string;
  readonly status: string;
  readonly tenant_id: string;
};
export type ParticipantLifecycle = {
  readonly access?: AccessGrant | null;
  readonly admission_request?: {
    readonly expires_at: string;
    readonly id: string;
    readonly status: string;
  } | null;
  readonly expires_at?: string;
  readonly lifecycle_intent: {
    readonly created_at: string;
    readonly id: string;
    readonly intent_name: string;
    readonly participant_generation?: number | null;
    readonly participant_id?: string | null;
    readonly request_key: string;
    readonly status: string;
  };
  readonly media_plane?: {
    readonly client_payload: Readonly<Record<string, unknown>>;
    readonly provider: string;
  } | null;
  readonly participant: Participant;
  readonly sync_token?: string;
};
export type RemoveParticipantInput = {
  readonly participantGeneration: number;
};
export type ParticipantRemoval = {
  readonly external_operation: ExternalOperation;
  readonly participant: Participant;
};
export type IssueAccessGrantInput =
  | {
      readonly participantGeneration: number;
      readonly currentMediaToken: string;
      readonly replaceMediaConnection?: false;
    }
  | {
      readonly participantGeneration: number;
      readonly currentMediaToken?: string;
      readonly replaceMediaConnection: true;
      readonly expectedMediaConnectionId?: string;
    };
export type SpacePublicInvite = {
  readonly admission_mode: string;
  readonly canonical_url: string;
  readonly created_at: string;
  readonly disabled_at?: string | null;
  readonly enabled: boolean;
  readonly generation: number;
  readonly public_role: string;
  readonly rotated_at?: string | null;
  readonly schema_version: string;
  readonly space_id: string;
  readonly tenant_id: string;
  readonly updated_at: string;
};
export type PublicAdmissionRequest = {
  readonly display_name: string;
  readonly expires_at: string;
  readonly request_handle: string;
  readonly requested_at: string;
  readonly state: string;
};
export type PublicAdmissionRequestPage = {
  readonly requests: readonly PublicAdmissionRequest[];
};
export type UpdateSpacePublicInviteInput = {
  readonly enabled: boolean;
};
export type ListPublicAdmissionRequestsInput = {
  readonly state?: "pending";
};
export type RecordingSourceStatus = "pending" | "available" | "failed" | "expired";
export type RecordingSource = {
  readonly expires_at?: string | null;
  readonly status: RecordingSourceStatus;
};
export type RecordingExportStatus = "none" | "pending" | "ready" | "failed" | "unavailable";
export type RecordingExport = {
  readonly failure_code?: string | null;
  readonly failure_message?: string | null;
  readonly job_id?: string | null;
  readonly retryable: boolean;
  readonly source_expires_at?: string | null;
  readonly status: RecordingExportStatus;
};
export type Recording = {
  readonly created_at: string;
  readonly episode_id: string;
  readonly export: RecordingExport;
  readonly failure_code: string | null;
  readonly id: string;
  readonly metadata: unknown;
  readonly source: RecordingSource;
  readonly space_id: string;
  readonly status: "pending" | "processing" | "completed" | "failed";
  readonly storage_key: string | null;
  readonly storage_provider: "r2";
  readonly tenant_id: string;
  readonly updated_at: string;
};
export type RecordingDownloadURL = {
  readonly expires_at: string;
  readonly method: string;
  readonly signed_at: string;
  readonly signed_headers: Readonly<Record<string, readonly string[]>>;
  readonly url: string;
};
export type RecordingExportRequestAcceptedResponse = {
  readonly export: RecordingExport;
  readonly recording: Recording;
};
export type RecordingList = {
  readonly pagination: Pagination;
  readonly recordings: readonly Recording[];
};
export type ListRecordingsInput = {
  readonly cursor?: string;
  readonly episodeId?: string;
  readonly pageSize?: number;
  readonly spaceId?: string;
};
export type CreateRecordingDownloadURLInput = {
  readonly expiresInSeconds: number;
  readonly download?: boolean;
};

type OpenAPISchema<Name extends keyof components["schemas"]> = components["schemas"][Name];
export type Transcript = OpenAPISchema<"Transcript">;
export type TranscriptList = OpenAPISchema<"TranscriptList">;
export type TranscriptDocument = OpenAPISchema<"TranscriptDocument">;
export type TranscriptDownloadURL = OpenAPISchema<"TranscriptDownloadURL">;
export type TranscriptRequestAccepted = OpenAPISchema<"TranscriptRequestAcceptedResponse">;
export type ListTranscriptsInput = {
  readonly cursor?: string;
  readonly pageSize?: number;
  readonly recordingId?: string;
};
export type RequestTranscriptInput = {
  readonly idempotencyKey: string;
  readonly language?: string;
  readonly languages?: readonly string[];
};
export type CreateTranscriptDownloadURLInput = {
  readonly expiresInSeconds: number;
};
export type WebhookEndpoint = OpenAPISchema<"WebhookEndpoint">;
export type WebhookEndpointWithSecret = OpenAPISchema<"WebhookEndpointWithSecret">;
export type WebhookEndpointList = OpenAPISchema<"WebhookEndpointList">;
export type WebhookDeliveryList = OpenAPISchema<"WebhookDeliveryList">;
export type WebhookDeliveryCreated = OpenAPISchema<"WebhookDeliveryCreated">;
export type RotateWebhookSecretResponse = OpenAPISchema<"RotateWebhookSecretResponse">;
export type WebhookEventType = WebhookEndpoint["event_types"][number];
export type WebhookDeliveryState = "pending" | "retry_wait" | "delivering" | "succeeded" | "exhausted" | "canceled" | "erased";
export type CreateWebhookEndpointInput = {
  readonly apiVersion: number;
  readonly enabled: boolean;
  readonly eventTypes: readonly WebhookEventType[];
  readonly name: string;
  readonly url: string;
};
export type UpdateWebhookEndpointInput = {
  readonly apiVersion?: number;
  readonly enabled?: boolean;
  readonly eventTypes?: readonly WebhookEventType[];
  readonly name?: string;
  readonly revision: number;
  readonly url?: string;
};
export type DeleteWebhookEndpointInput = {
  readonly revision: number;
};
export type RotateWebhookSecretInput = {
  readonly revokePreviousImmediately: boolean;
};
export type ListWebhookEndpointsInput = {
  readonly cursor?: string;
  readonly pageSize?: number;
};
export type ListWebhookDeliveriesInput = {
  readonly cursor?: string;
  readonly eventTypes?: readonly WebhookEventType[];
  readonly pageSize?: number;
  readonly states?: readonly WebhookDeliveryState[];
};
export type ScheduledEpisode = OpenAPISchema<"ScheduledEpisode">;
export type ScheduledEpisodeParticipantInput = {
  readonly identityExternalId?: string;
  readonly name: string;
  readonly role?: string;
};
export type PutScheduledEpisodeInput = {
  readonly expectedEndsAt: string;
  readonly expectedParticipants?: readonly ScheduledEpisodeParticipantInput[];
  readonly metadata?: unknown;
  readonly startsAt: string;
};

export type ChalkServerClient = {
  readonly spaces: {
    archive(spaceId: string): Promise<Space>;
    create(input: CreateSpaceInput, options?: ChalkIdempotencyOptions): Promise<Space>;
    get(spaceId: string): Promise<Space>;
    list(input?: ListSpacesInput): Promise<SpaceList>;
    restore(spaceId: string): Promise<Space>;
    update(spaceId: string, input: UpdateSpaceInput): Promise<Space>;
  };
  readonly episodes: {
    create(spaceId: string, input: CreateEpisodeInput, options?: ChalkIdempotencyOptions): Promise<Episode>;
    end(spaceId: string, episodeId: string, options?: ChalkIdempotencyOptions): Promise<EpisodeEnd>;
  };
  readonly participants: {
    admit(spaceId: string, episodeId: string, input: AdmitParticipantInput, options?: ChalkIdempotencyOptions): Promise<ParticipantLifecycle>;
    issueAccess(spaceId: string, episodeId: string, participantId: string, input: IssueAccessGrantInput, refreshRequest?: AccessRefreshRequest): Promise<AccessGrant>;
    remove(spaceId: string, episodeId: string, participantId: string, input: RemoveParticipantInput, options?: ChalkIdempotencyOptions): Promise<ParticipantRemoval>;
  };
  readonly apiKeys: {
    create(input: CreateAPIKeyInput): Promise<APIKeyWithSecret>;
    list(input?: ListAPIKeysInput): Promise<APIKeyList>;
    rotate(apiKeyId: string, input?: RotateAPIKeyInput): Promise<APIKeyWithSecret>;
    revoke(apiKeyId: string): Promise<void>;
  };
  readonly recordings: {
    list(input?: ListRecordingsInput): Promise<RecordingList>;
    get(recordingId: string): Promise<Recording>;
    requestExport(recordingId: string): Promise<RecordingExportRequestAcceptedResponse>;
    createDownloadURL(recordingId: string, input: CreateRecordingDownloadURLInput): Promise<RecordingDownloadURL>;
  };
  readonly transcripts: {
    list(input?: ListTranscriptsInput): Promise<TranscriptList>;
    get(transcriptId: string): Promise<Transcript>;
    document(transcriptId: string): Promise<TranscriptDocument>;
    text(transcriptId: string): Promise<string>;
    createDownloadURL(transcriptId: string, input: CreateTranscriptDownloadURLInput): Promise<TranscriptDownloadURL>;
    request(recordingId: string, input: RequestTranscriptInput): Promise<TranscriptRequestAccepted>;
    delete(transcriptId: string): Promise<void>;
  };
  readonly webhookEndpoints: {
    create(input: CreateWebhookEndpointInput, options?: ChalkIdempotencyOptions): Promise<WebhookEndpointWithSecret>;
    list(input?: ListWebhookEndpointsInput): Promise<WebhookEndpointList>;
    get(endpointId: string): Promise<WebhookEndpoint>;
    update(endpointId: string, input: UpdateWebhookEndpointInput, options?: ChalkIdempotencyOptions): Promise<WebhookEndpoint>;
    rotateSecret(endpointId: string, input: RotateWebhookSecretInput, options?: ChalkIdempotencyOptions): Promise<RotateWebhookSecretResponse>;
    delete(endpointId: string, input: DeleteWebhookEndpointInput, options?: ChalkIdempotencyOptions): Promise<void>;
    listDeliveries(endpointId: string, input?: ListWebhookDeliveriesInput): Promise<WebhookDeliveryList>;
    redeliver(endpointId: string, deliveryId: string, options?: ChalkIdempotencyOptions): Promise<WebhookDeliveryCreated>;
  };
  readonly scheduledEpisodes: {
    put(spaceId: string, scheduledEpisodeId: string, input: PutScheduledEpisodeInput): Promise<ScheduledEpisode>;
    get(spaceId: string, scheduledEpisodeId: string): Promise<ScheduledEpisode>;
    delete(spaceId: string, scheduledEpisodeId: string): Promise<void>;
  };
  readonly publicInvites: {
    get(spaceId: string): Promise<SpacePublicInvite>;
    update(spaceId: string, input: UpdateSpacePublicInviteInput): Promise<SpacePublicInvite>;
    rotate(spaceId: string, options?: ChalkIdempotencyOptions): Promise<SpacePublicInvite>;
  };
  readonly publicAdmissionRequests: {
    list(spaceId: string, input?: ListPublicAdmissionRequestsInput): Promise<PublicAdmissionRequestPage>;
    approve(spaceId: string, requestHandle: string, options?: ChalkIdempotencyOptions): Promise<PublicAdmissionRequest>;
    deny(spaceId: string, requestHandle: string, options?: ChalkIdempotencyOptions): Promise<PublicAdmissionRequest>;
  };
};
