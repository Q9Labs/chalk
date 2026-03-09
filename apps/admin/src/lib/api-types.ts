export type NullableTime = {
  Valid?: boolean;
  Time?: string;
};

export type OverviewResponse = {
  overview?: {
    active_tenants?: number;
    active_rooms?: number;
    total_rooms?: number;
    total_recordings?: number;
    total_storage_bytes?: number;
    active_participants?: number;
  };
  webhook_stats?: {
    delivered: number;
    failed: number;
    pending: number;
    total: number;
  };
  storage_stats?: Array<{
    storage_provider: string;
    total_bytes: number;
    recording_count: number;
  }>;
};

export type TenantSummary = {
  id: string;
  name: string;
  is_active: boolean;
  active_rooms: number;
  total_rooms: number;
  total_recordings: number;
  storage_bytes: number;
  created_at: string;
};

export type TenantDetail = Record<string, unknown> & {
  id: string;
  name: string;
  is_active: boolean;
  api_key_hash?: unknown;
  tenant_config?: unknown;
  whiteboard_config?: unknown;
  max_concurrent_rooms?: number | null;
  max_participants_per_room?: number | null;
  max_recording_duration_minutes?: number | null;
};

export type RoomSummary = {
  id: string;
  name?: string | null;
  tenant_name?: string | null;
  status?: string | null;
  active_participant_count?: number | null;
  started_at?: NullableTime | null;
  created_at: string;
  config?: unknown;
};

export type ParticipantSummary = {
  display_name?: string | null;
  role?: string | null;
  external_user_id?: string | null;
  joined_at?: NullableTime | null;
  left_at?: NullableTime | null;
};

export type RoomDetailResponse = {
  room?: RoomSummary;
  participants?: ParticipantSummary[];
};

export type RecordingSummary = {
  room_name?: string | null;
  tenant_name?: string | null;
  status?: string | null;
  storage_provider?: string | null;
  size_bytes?: number | null;
  duration_seconds?: number | null;
  created_at: string;
};

export type TranscriptSummary = {
  id: string;
  room_name?: string | null;
  tenant_name?: string | null;
  status?: string | null;
  provider?: string | null;
  word_count?: number | null;
  created_at: string;
  summary?: string | null;
  action_items?: string[] | null;
  error_message?: string | null;
};

export type WebhookDelivery = {
  id: string;
  event_type?: string | null;
  tenant_name?: string | null;
  status?: string | null;
  attempts?: number | null;
  max_attempts?: number | null;
  webhook_url?: string | null;
  last_error?: string | null;
  payload?: unknown;
  created_at: string;
};

export type AuditLog = {
  id: string;
  action?: string | null;
  actor_id?: string | null;
  resource_type?: string | null;
  tenant_name?: string | null;
  ip_address?: string | null;
  created_at: string;
  metadata?: unknown;
};

export type UsageResponse = {
  meeting_durations?: Array<{
    tenant_name: string;
    total_duration_seconds: number;
  }>;
  storage_by_provider?: Array<{
    storage_provider: string;
    total_bytes: number;
    recording_count: number;
  }>;
};
