import type { OpsConfig, OpsIncident, OpsIncidentDetails, OpsOverview } from "./types";

const DEFAULT_API_URL = "http://localhost:8080";
const INCIDENTS_ROOT = "/api/v1/admin/ops";

export function loadOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const apiUrl = (env.CHALK_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  const adminSecret = env.CHALK_ADMIN_SECRET?.trim() ?? "";
  if (!adminSecret) {
    throw new Error("Missing CHALK_ADMIN_SECRET. Set it before running the incident TUI.");
  }
  return { apiUrl, adminSecret };
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractErrorMessage(data: unknown): string {
  if (isRecord(data)) {
    const message = data.message ?? data.error ?? data.detail;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  if (typeof data === "string" && data.trim().length > 0) {
    return data.trim();
  }
  return "Request failed";
}

export async function requestOpsApi<T>(config: OpsConfig, path: string, options?: { query?: Record<string, string | number | undefined> }): Promise<T> {
  const url = new URL(path, normalizeBaseUrl(config.apiUrl));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options?.query ?? {})) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  if (Array.from(params.keys()).length > 0) {
    url.search = params.toString();
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-admin-secret": config.adminSecret,
    },
  });

  const text = await response.text();
  let data: unknown = null;
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${extractErrorMessage(data)}`);
  }

  return data as T;
}

export function getOpsOverview(config: OpsConfig): Promise<OpsOverview> {
  return requestOpsApi<OpsOverview>(config, `${INCIDENTS_ROOT}/overview`);
}

export function listOpsIncidents(config: OpsConfig, limit = 50): Promise<OpsIncident[]> {
  return requestOpsApi<OpsIncident[]>(config, `${INCIDENTS_ROOT}/incidents`, { query: { limit, offset: 0 } });
}

export function getOpsIncident(config: OpsConfig, incidentCode: string): Promise<OpsIncidentDetails> {
  return requestOpsApi<OpsIncidentDetails>(config, `${INCIDENTS_ROOT}/incidents/${encodeURIComponent(incidentCode)}`);
}
