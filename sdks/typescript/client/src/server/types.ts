import type { AccessGrant } from "../access/grant.js";

export type { AccessGrant } from "../access/grant.js";

export type ChalkServerHeaders = Readonly<Record<string, string>>;

export type ChalkServerTelemetry = {
  readonly journeyId: string;
  readonly rootJourneyId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
};

export type ChalkServerClientOptions = {
  readonly apiKey: string;
  readonly tenantId: string;
  readonly apiBaseURL: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: ChalkServerHeaders;
  readonly telemetry?: ChalkServerTelemetry;
};

export type ChalkIdempotencyOptions = { readonly idempotencyKey?: string };

export type CreateSpaceInput = {
  readonly admissionPolicy?: unknown;
  readonly defaultEpisodeDurationSeconds: number;
  readonly lingerWindowSeconds: number;
  readonly maximumEpisodeDurationSeconds: number;
  readonly mediaPlane: string;
  readonly metadata?: unknown;
  readonly name: string;
  readonly recurringPolicy?: unknown;
  readonly slug: string;
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
  readonly metadata: unknown;
  readonly name: string;
  readonly recurring_policy: unknown;
  readonly roles: readonly {
    readonly capabilities: readonly string[];
    readonly id: string;
    readonly name: string;
  }[];
  readonly slug: string;
  readonly tenant_id: string;
  readonly updated_at: string;
};

export type SpaceList = {
  readonly spaces: readonly Space[];
  readonly pagination: { readonly has_more: boolean; readonly next_cursor: string | null; readonly page_size: number };
};

export type ListSpacesInput = { readonly archived?: boolean; readonly cursor?: string; readonly pageSize?: number };

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
  readonly external_operation: ExternalOperation;
  readonly status: string;
};

export type AdmitParticipantInput = {
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
  readonly admission_request?: { readonly expires_at: string; readonly id: string; readonly status: string } | null;
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
  readonly media_plane?: { readonly client_payload: Readonly<Record<string, unknown>>; readonly provider: string } | null;
  readonly participant: Participant;
  readonly sync_token?: string;
};

export type RemoveParticipantInput = { readonly participantGeneration: number };

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
      readonly currentMediaToken?: never;
      readonly replaceMediaConnection: true;
    };

export type APIKey = {
  readonly created_at: string;
  readonly created_by_user_id: string | null;
  readonly expires_at: string;
  readonly id: string;
  readonly key_prefix: string;
  readonly last_used_at: string | null;
  readonly name: string;
  readonly revoked_at: string | null;
  readonly scopes: readonly string[];
  readonly tenant_id: string;
  readonly updated_at: string;
};

export type APIKeyList = {
  readonly api_keys: readonly APIKey[];
  readonly pagination: { readonly has_more: boolean; readonly next_cursor: string | null; readonly page_size: number };
};

export type APIKeyWithSecret = { readonly api_key: APIKey; readonly secret: string };
export type CreateAPIKeyInput = { readonly expiresAt: string; readonly name: string; readonly scopes: readonly string[] };
export type ListAPIKeysInput = { readonly cursor?: string; readonly pageSize?: number };
export type RotateAPIKeyInput = { readonly expiresAt?: string | null };

export type ChalkServerClient = {
  readonly spaces: {
    archive(spaceId: string): Promise<Space>;
    create(input: CreateSpaceInput, options?: ChalkIdempotencyOptions): Promise<Space>;
    get(spaceId: string): Promise<Space>;
    list(input?: ListSpacesInput): Promise<SpaceList>;
    restore(spaceId: string): Promise<Space>;
  };
  readonly episodes: {
    create(spaceId: string, input: CreateEpisodeInput, options?: ChalkIdempotencyOptions): Promise<Episode>;
    end(spaceId: string, episodeId: string, options?: ChalkIdempotencyOptions): Promise<EpisodeEnd>;
  };
  readonly participants: {
    admit(spaceId: string, episodeId: string, input: AdmitParticipantInput, options?: ChalkIdempotencyOptions): Promise<ParticipantLifecycle>;
    issueAccess(spaceId: string, episodeId: string, participantId: string, input: IssueAccessGrantInput): Promise<AccessGrant>;
    remove(spaceId: string, episodeId: string, participantId: string, input: RemoveParticipantInput, options?: ChalkIdempotencyOptions): Promise<ParticipantRemoval>;
  };
  readonly apiKeys: {
    create(input: CreateAPIKeyInput): Promise<APIKeyWithSecret>;
    list(input?: ListAPIKeysInput): Promise<APIKeyList>;
    rotate(apiKeyId: string, input?: RotateAPIKeyInput): Promise<APIKeyWithSecret>;
    revoke(apiKeyId: string): Promise<void>;
  };
};
