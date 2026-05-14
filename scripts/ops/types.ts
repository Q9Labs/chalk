export type NullableTimestamp = string | { Time?: string; time?: string; Valid?: boolean; valid?: boolean } | null | undefined;

export interface OpsIncident {
  id?: string;
  incident_code: string;
  title: string;
  summary?: string | null;
  severity: string;
  status: string;
  visibility: string;
  source_kind?: string;
  source_key?: string | null;
  component_ids?: string[];
  public_message?: string | null;
  public_title?: string | null;
  first_seen_at?: NullableTimestamp;
  last_seen_at?: NullableTimestamp;
  resolved_at?: NullableTimestamp;
  published_at?: NullableTimestamp;
  created_at?: NullableTimestamp;
  updated_at?: NullableTimestamp;
}

export interface OpsIncidentEvent {
  id?: string;
  event_type: string;
  visibility: string;
  actor_kind?: string;
  actor_id?: string;
  message: string;
  event_at?: NullableTimestamp;
  created_at?: NullableTimestamp;
}

export interface OpsMaintenanceWindow {
  id: string;
  title: string;
  summary?: string | null;
  component_ids?: string[];
  visibility: string;
  status: string;
  starts_at?: NullableTimestamp;
  ends_at?: NullableTimestamp;
  public_message?: string | null;
}

export interface OpsMonitorResult {
  monitor_key: string;
  monitor_kind?: string;
  status: string;
  http_status?: number | null;
  latency_ms?: number | null;
  checked_at?: NullableTimestamp;
  error_message?: string | null;
}

export interface OpsHeartbeatEvent {
  heartbeat_key: string;
  status: string;
  event_at?: NullableTimestamp;
  error_message?: string | null;
}

export interface OpsOverview {
  incidents: OpsIncident[];
  maintenance: OpsMaintenanceWindow[];
  signals: {
    monitors: OpsMonitorResult[];
    heartbeats: OpsHeartbeatEvent[];
  };
}

export interface OpsIncidentDetails {
  incident: OpsIncident;
  events: OpsIncidentEvent[];
}

export interface OpsConfig {
  apiUrl: string;
  adminSecret: string;
}
