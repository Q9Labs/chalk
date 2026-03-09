import type { AuditLog, OverviewResponse, RecordingSummary, RoomDetailResponse, RoomSummary, TranscriptSummary, TenantSummary, TenantDetail, UsageResponse, WebhookDelivery } from "./api-types";

const ENV_KEY = "chalk-admin-env";
const SECRET_KEY = "chalk-admin-secret-prod";

type Env = "local" | "prod";

const BASE_URLS = {
  local: "http://localhost:8080/api/v1/admin",
  prod: "https://chalk-api.q9labs.ai/api/v1/admin",
} as const;

let runtimeSecret: string | null = null;

export function getEnv(): Env {
  return (localStorage.getItem(ENV_KEY) as Env) || "local";
}

export function setEnv(env: Env) {
  localStorage.setItem(ENV_KEY, env);
  runtimeSecret = null;
}

export function getSecret(): string {
  if (runtimeSecret) return runtimeSecret;
  const env = getEnv();
  if (env === "local") {
    return import.meta.env.VITE_ADMIN_SECRET || "admin-dev-secret-change-in-production";
  }
  return localStorage.getItem(SECRET_KEY) || "";
}

export function setSecret(secret: string) {
  runtimeSecret = secret;
  localStorage.setItem(SECRET_KEY, secret);
}

export function getBaseUrl(): string {
  return import.meta.env.VITE_ADMIN_API_URL || BASE_URLS[getEnv()];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const secret = getSecret();
  if (!secret) {
    throw new Error("Admin secret not set. Configure it in settings.");
  }

  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Secret": secret,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── API Methods ──

export const api = {
  getOverview: () => request<OverviewResponse>("/overview"),

  listTenants: (limit = 50, offset = 0) => request<TenantSummary[]>(`/tenants?limit=${limit}&offset=${offset}`),

  getTenant: (id: string) => request<TenantDetail>(`/tenants/${id}`),

  createTenant: (data: { name: string; max_concurrent_rooms?: number; max_participants_per_room?: number; max_recording_duration_minutes?: number }) => request<unknown>("/tenants", { method: "POST", body: JSON.stringify(data) }),

  updateTenant: (id: string, data: Record<string, unknown>) => request<unknown>(`/tenants/${id}`, { method: "PATCH", body: JSON.stringify(data) }),

  updateTenantConfig: (id: string, config: Record<string, unknown>) => request<unknown>(`/tenants/${id}/config`, { method: "PATCH", body: JSON.stringify(config) }),

  updateWhiteboardConfig: (id: string, config: Record<string, unknown>) => request<unknown>(`/tenants/${id}/whiteboard-config`, { method: "PATCH", body: JSON.stringify(config) }),

  rotateKey: (id: string) => request<{ api_key: string }>(`/tenants/${id}/rotate-key`, { method: "POST" }),

  activateTenant: (id: string) => request<unknown>(`/tenants/${id}/activate`, { method: "PATCH" }),

  deactivateTenant: (id: string) => request<unknown>(`/tenants/${id}/deactivate`, { method: "PATCH" }),

  deleteTenant: (id: string) => request<void>(`/tenants/${id}`, { method: "DELETE" }),

  listRooms: (limit = 50, offset = 0) => request<RoomSummary[]>(`/rooms?limit=${limit}&offset=${offset}`),

  getRoom: (id: string) => request<RoomDetailResponse>(`/rooms/${id}`),

  listRecordings: (limit = 50, offset = 0) => request<RecordingSummary[]>(`/recordings?limit=${limit}&offset=${offset}`),

  listTranscripts: (limit = 50, offset = 0) => request<TranscriptSummary[]>(`/transcripts?limit=${limit}&offset=${offset}`),

  listWebhooks: (limit = 50, offset = 0) => request<WebhookDelivery[]>(`/webhooks?limit=${limit}&offset=${offset}`),

  listAuditLogs: (limit = 50, offset = 0) => request<AuditLog[]>(`/audit-logs?limit=${limit}&offset=${offset}`),

  getUsage: () => request<UsageResponse>("/usage"),
};
