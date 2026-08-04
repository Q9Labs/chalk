export type DashboardAccount = {
  id: string;
  name: string;
  email: string;
  updated_at: string;
  created_at: string;
};

export type Tenant = {
  id: string;
  name: string;
  default_region: string | null;
  logo_key: string | null;
  website: string | null;
  updated_at: string;
  created_at: string;
};

export type TenantAccess = {
  id: string;
  tenant_id: string;
  account_id: string;
  role: string;
  updated_at: string;
  created_at: string;
};

export type AccountTenant = { tenant: Tenant; access: TenantAccess };
type AccountTenantPage = {
  tenants: AccountTenant[];
  pagination: { page_size: number; next_cursor: string | null; has_more: boolean };
};
export type Region = { code: string; name: string };

let csrfToken: string | undefined;
let csrfExpiresAt = 0;
const CSRF_REFRESH_MS = 55 * 60 * 1000;

export class DashboardAPIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function registerAccount(input: { name: string; email: string; password: string }): Promise<DashboardAccount> {
  const response = await dashboardRequest<{ user: DashboardAccount }>("/api/auth/register", { method: "POST", body: input });
  return response.user;
}

export async function loginAccount(input: { email: string; password: string }): Promise<DashboardAccount> {
  const response = await dashboardRequest<{ user: DashboardAccount }>("/api/auth/login", { method: "POST", body: input });
  return response.user;
}

export async function logoutAccount(): Promise<void> {
  await dashboardRequest("/api/auth/logout", { method: "POST", body: {} });
  csrfToken = undefined;
  csrfExpiresAt = 0;
}

export function getAccount(): Promise<DashboardAccount> {
  return dashboardRequest("/api/me");
}

function listAccountTenants(options: { cursor?: string; pageSize?: number } = {}): Promise<AccountTenantPage> {
  const query = new URLSearchParams();
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.pageSize) query.set("page_size", String(options.pageSize));
  const search = query.toString();
  return dashboardRequest(`/api/me/tenants${search ? `?${search}` : ""}`);
}

export async function listAllAccountTenants(): Promise<AccountTenant[]> {
  const tenants: AccountTenant[] = [];
  let cursor: string | undefined;
  do {
    const page = await listAccountTenants({ cursor, pageSize: 100 });
    tenants.push(...page.tenants);
    cursor = page.pagination.has_more ? (page.pagination.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return tenants;
}

export async function listRegions(): Promise<Region[]> {
  const response = await dashboardRequest<{ regions: Region[] }>("/api/regions");
  return response.regions;
}

export async function onboardTenant(input: { name: string; default_region: string }): Promise<AccountTenant> {
  const fingerprint = JSON.stringify({ name: input.name.trim(), default_region: input.default_region });
  const requestKey = tenantOnboardingRequestKey(fingerprint);
  const response = await dashboardRequest<AccountTenant & { replayed: boolean }>("/api/me/tenants", {
    method: "POST",
    body: input,
    headers: { "Idempotency-Key": requestKey },
  });
  window.localStorage.removeItem("chalk.tenant-onboarding-request");
  return { tenant: response.tenant, access: response.access };
}

type DashboardRequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: HeadersInit;
};

type DashboardRequestCorrelation = {
  journeyID: string;
  traceparent: string;
};

async function dashboardRequest<T = unknown>(path: string, options: DashboardRequestOptions = {}, retryCSRF = true, correlation: DashboardRequestCorrelation = newDashboardRequestCorrelation()): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Chalk-Journey-ID", correlation.journeyID);
  headers.set("Traceparent", correlation.traceparent);
  if (method !== "GET") {
    headers.set("Content-Type", "application/json");
    headers.set("X-Chalk-CSRF", await getCSRFToken());
  }
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const value = await readJSON(response);
    const error = isRecord(value.error) ? value.error : {};
    const code = stringValue(error.code) ?? "request_failed";
    if (retryCSRF && method !== "GET" && response.status === 403 && code === "csrf_mismatch") {
      csrfToken = undefined;
      csrfExpiresAt = 0;
      return dashboardRequest(path, options, false, correlation);
    }
    throw new DashboardAPIError(response.status, code, stringValue(error.message) ?? "Request failed");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function newDashboardRequestCorrelation(): DashboardRequestCorrelation {
  return { journeyID: crypto.randomUUID(), traceparent: newTraceparent() };
}

async function getCSRFToken(): Promise<string> {
  if (csrfToken && Date.now() < csrfExpiresAt) return csrfToken;
  const response = await fetch("/api/auth/csrf", { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!response.ok) throw new DashboardAPIError(response.status, "csrf_unavailable", "Could not secure this request");
  const value = (await response.json()) as { csrf_token?: unknown };
  if (typeof value.csrf_token !== "string") throw new DashboardAPIError(502, "csrf_unavailable", "Could not secure this request");
  csrfToken = value.csrf_token;
  csrfExpiresAt = Date.now() + CSRF_REFRESH_MS;
  return csrfToken;
}

function tenantOnboardingRequestKey(fingerprint: string): string {
  const storageKey = "chalk.tenant-onboarding-request";
  try {
    const existing = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as { fingerprint?: unknown; key?: unknown } | null;
    if (existing?.fingerprint === fingerprint && typeof existing.key === "string") return existing.key;
  } catch {
    // Replace malformed local retry metadata below.
  }
  const key = crypto.randomUUID().replaceAll("-", "");
  window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
  return key;
}

function newTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function randomHex(size: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function readJSON(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
