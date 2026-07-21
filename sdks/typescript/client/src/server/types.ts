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

export type CreateRoomInput = {
  readonly media_plane: string;
  readonly metadata?: unknown;
  readonly name: string;
  readonly recurring_policy?: unknown;
  readonly slug: string;
  readonly status: "active" | "archived" | "ended";
};

export type Room = {
  readonly created_at: string;
  readonly created_by_user_id: string | null;
  readonly id: string;
  readonly media_plane: string;
  readonly metadata: unknown;
  readonly name: string;
  readonly recurring_policy: unknown;
  readonly slug: string;
  readonly status: "active" | "archived" | "ended";
  readonly tenant_id: string;
  readonly updated_at: string;
};

export type CreateSessionInput = {
  readonly admission_policy: string;
  readonly host_exit_policy: string;
  readonly maximum_duration_seconds: number;
  readonly metadata?: unknown;
  readonly role_capabilities: Readonly<Record<string, readonly string[]>>;
  readonly started_at?: string | null;
};

export type RoomSession = {
  readonly created_at: string;
  readonly created_by_user_id: string | null;
  readonly ended_at: string | null;
  readonly id: string;
  readonly metadata: unknown;
  readonly room_id: string;
  readonly started_at: string | null;
  readonly status: "pending" | "active" | "ended" | "failed";
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
  readonly target_participant_session_generation?: number | null;
  readonly target_participant_session_id?: string | null;
};

export type EndSessionResult = { readonly external_operation: ExternalOperation; readonly session_id: string; readonly status: string };

export type AdmitParticipantInput = {
  readonly eligible_roles: readonly string[];
  readonly initial_role: string;
  readonly metadata?: unknown;
  readonly name: string;
  readonly participant_session_id: string;
};

export type ParticipantAccess = {
  readonly subject: {
    readonly tenantId: string;
    readonly roomId: string;
    readonly sessionId: string;
    readonly participantSessionId: string;
    readonly participantGeneration: number;
  };
  readonly sync: { readonly token: string; readonly expiresAt: string };
  readonly media: {
    readonly token: string;
    readonly expiresAt: string;
    readonly provider: "cloudflare_sfu";
    readonly clientPayload: { readonly connectionId: string; readonly stunServer: string };
  };
};

export type ParticipantAdmission = {
  readonly access?: ParticipantAccess | null;
  readonly admission_request?: { readonly expires_at: string; readonly id: string; readonly status: string } | null;
  readonly expires_at?: string;
  readonly lifecycle_intent: {
    readonly created_at: string;
    readonly id: string;
    readonly intent_name: string;
    readonly participant_session_generation: number | null;
    readonly participant_session_id: string | null;
    readonly request_key: string;
    readonly status: string;
  };
  readonly media_plane?: { readonly client_payload: Readonly<Record<string, unknown>>; readonly provider: string } | null;
  readonly participant: {
    readonly generation: number;
    readonly id: string;
    readonly room_id: string;
    readonly session_id: string;
    readonly status: string;
    readonly tenant_id: string;
  };
  readonly sync_token?: string;
};

export type IssueParticipantAccessInput = { readonly participantSessionGeneration: number; readonly currentMediaToken: string; readonly replaceMediaConnection?: false } | { readonly participantSessionGeneration: number; readonly currentMediaToken?: never; readonly replaceMediaConnection: true };

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
  readonly rooms: { create(input: CreateRoomInput): Promise<Room> };
  readonly sessions: {
    create(roomId: string, input: CreateSessionInput, options?: ChalkIdempotencyOptions): Promise<RoomSession>;
    end(roomId: string, sessionId: string, options?: ChalkIdempotencyOptions): Promise<EndSessionResult>;
  };
  readonly participants: {
    admit(roomId: string, sessionId: string, input: AdmitParticipantInput, options?: ChalkIdempotencyOptions): Promise<ParticipantAdmission>;
    issueAccess(roomId: string, sessionId: string, participantSessionId: string, input: IssueParticipantAccessInput): Promise<ParticipantAccess>;
  };
  readonly apiKeys: {
    create(input: CreateAPIKeyInput): Promise<APIKeyWithSecret>;
    list(input?: ListAPIKeysInput): Promise<APIKeyList>;
    rotate(apiKeyId: string, input?: RotateAPIKeyInput): Promise<APIKeyWithSecret>;
    revoke(apiKeyId: string): Promise<void>;
  };
};
