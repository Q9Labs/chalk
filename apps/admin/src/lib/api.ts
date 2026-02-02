const ENV_KEY = "chalk-admin-env"

type Env = "local" | "prod"

const BASE_URLS = {
  local: "http://localhost:8080/api/v1/admin",
  prod: "https://chalk-api.q9labs.ai/api/v1/admin",
} as const

let runtimeSecret: string | null = null

export function getEnv(): Env {
  return (localStorage.getItem(ENV_KEY) as Env) || "local"
}

export function setEnv(env: Env) {
  localStorage.setItem(ENV_KEY, env)
  runtimeSecret = null
}

export function getSecret(): string {
  if (runtimeSecret) return runtimeSecret
  const env = getEnv()
  if (env === "local") {
    return import.meta.env.VITE_ADMIN_SECRET || "admin-dev-secret-change-in-production"
  }
  return ""
}

export function setSecret(secret: string) {
  runtimeSecret = secret
}

export function getBaseUrl(): string {
  return import.meta.env.VITE_ADMIN_API_URL || BASE_URLS[getEnv()]
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const secret = getSecret()
  if (!secret) {
    throw new Error("Admin secret not set. Configure it in settings.")
  }

  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Secret": secret,
      ...options.headers,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error || `HTTP ${res.status}`)
  }

  if (res.status === 204) return undefined as T
  return res.json()
}

// ── API Methods ──

export const api = {
  getOverview: () => request<any>("/overview"),

  listTenants: (limit = 50, offset = 0) =>
    request<any[]>(`/tenants?limit=${limit}&offset=${offset}`),

  getTenant: (id: string) => request<any>(`/tenants/${id}`),

  createTenant: (data: { name: string; max_concurrent_rooms?: number; max_participants_per_room?: number; max_recording_duration_minutes?: number }) =>
    request<any>("/tenants", { method: "POST", body: JSON.stringify(data) }),

  updateTenant: (id: string, data: Record<string, unknown>) =>
    request<any>(`/tenants/${id}`, { method: "PATCH", body: JSON.stringify(data) }),

  updateTenantConfig: (id: string, config: Record<string, unknown>) =>
    request<any>(`/tenants/${id}/config`, { method: "PATCH", body: JSON.stringify(config) }),

  updateWhiteboardConfig: (id: string, config: Record<string, unknown>) =>
    request<any>(`/tenants/${id}/whiteboard-config`, { method: "PATCH", body: JSON.stringify(config) }),

  rotateKey: (id: string) =>
    request<{ api_key: string }>(`/tenants/${id}/rotate-key`, { method: "POST" }),

  activateTenant: (id: string) =>
    request<any>(`/tenants/${id}/activate`, { method: "PATCH" }),

  deactivateTenant: (id: string) =>
    request<any>(`/tenants/${id}/deactivate`, { method: "PATCH" }),

  deleteTenant: (id: string) =>
    request<void>(`/tenants/${id}`, { method: "DELETE" }),

  listRooms: (limit = 50, offset = 0) =>
    request<any[]>(`/rooms?limit=${limit}&offset=${offset}`),

  getRoom: (id: string) => request<any>(`/rooms/${id}`),

  listRecordings: (limit = 50, offset = 0) =>
    request<any[]>(`/recordings?limit=${limit}&offset=${offset}`),

  listTranscripts: (limit = 50, offset = 0) =>
    request<any[]>(`/transcripts?limit=${limit}&offset=${offset}`),

  listWebhooks: (limit = 50, offset = 0) =>
    request<any[]>(`/webhooks?limit=${limit}&offset=${offset}`),

  listAuditLogs: (limit = 50, offset = 0) =>
    request<any[]>(`/audit-logs?limit=${limit}&offset=${offset}`),

  getUsage: () => request<any>("/usage"),
}
