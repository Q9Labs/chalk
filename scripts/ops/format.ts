import type { NullableTimestamp, OpsHeartbeatEvent, OpsIncident, OpsMaintenanceWindow, OpsMonitorResult } from "./types";

export function timestampValue(value: NullableTimestamp): string | null {
  if (!value) return null;
  if (typeof value === "string") {
    return Number.isNaN(new Date(value).valueOf()) ? null : value;
  }
  const valid = value.Valid ?? value.valid;
  if (valid === false) return null;
  const nested = value.Time ?? value.time;
  return nested && !Number.isNaN(new Date(nested).valueOf()) ? nested : null;
}

export function shortTime(value: NullableTimestamp): string {
  const timestamp = timestampValue(value);
  if (!timestamp) return "--:--";
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function relativeAge(value: NullableTimestamp, now = Date.now()): string {
  const timestamp = timestampValue(value);
  if (!timestamp) return "unknown";
  const diffSeconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function trimCell(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width, " ");
}

export function incidentGlyph(incident: OpsIncident): string {
  if (incident.status === "resolved") return "✓";
  if (incident.severity === "critical") return "!";
  if (incident.severity === "major") return "◐";
  if (incident.severity === "minor") return "◌";
  return "·";
}

export function signalGlyph(status: string): string {
  switch (status) {
    case "healthy":
    case "ok":
      return "✓";
    case "degraded":
      return "◐";
    case "failed":
      return "×";
    default:
      return "·";
  }
}

export function incidentSortTime(incident: OpsIncident): number {
  const timestamp = timestampValue(incident.last_seen_at) ?? timestampValue(incident.created_at) ?? timestampValue(incident.first_seen_at);
  return timestamp ? new Date(timestamp).getTime() : 0;
}

export function filterIncident(incident: OpsIncident, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [incident.incident_code, incident.title, incident.summary ?? "", incident.severity, incident.status, incident.visibility, incident.source_key ?? "", ...(incident.component_ids ?? [])].join(" ").toLowerCase().includes(needle);
}

export function statusColor(status: string): string {
  switch (status) {
    case "healthy":
    case "ok":
    case "resolved":
      return "#7dd3a3";
    case "monitoring":
    case "degraded":
      return "#f4a51c";
    case "failed":
    case "critical":
    case "investigating":
      return "#f87171";
    default:
      return "#9f9788";
  }
}

export function describeMonitor(signal: OpsMonitorResult): string {
  const detail = signal.error_message ? ` ${signal.error_message}` : signal.http_status ? ` HTTP ${signal.http_status}` : signal.latency_ms ? ` ${signal.latency_ms}ms` : "";
  return `${signalGlyph(signal.status)} ${signal.monitor_key} ${signal.status}${detail}`;
}

export function describeHeartbeat(signal: OpsHeartbeatEvent): string {
  const detail = signal.error_message ? ` ${signal.error_message}` : "";
  return `${signalGlyph(signal.status)} ${signal.heartbeat_key} ${signal.status}${detail}`;
}

export function describeMaintenance(window: OpsMaintenanceWindow): string {
  return `- ${window.title} ${window.status} ${shortTime(window.starts_at)}-${shortTime(window.ends_at)}`;
}
