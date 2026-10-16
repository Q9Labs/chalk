import { Effect, Schema, SchemaIssue } from "effect";
import { createChalkEffectClient, type AccountTenantList, type AuthUser, type Pagination, type Space as GeneratedSpace, type Tenant as GeneratedTenant } from "@q9labsai/chalk-client/effect";

type AccountValue<T> = T extends string ? string : T extends readonly (infer Item)[] ? AccountValue<Item>[] : T extends object ? { -readonly [Key in keyof T]: AccountValue<T[Key]> } : T;
export type AccountUser = AccountValue<AuthUser>;
export type Tenant = AccountValue<GeneratedTenant>;
export type TenantAccess = AccountValue<AccountTenantList["tenants"][number]["access"]>;
export type AccountTenant = { tenant: Tenant; access: TenantAccess };
type AccountTenantPage = { tenants: AccountTenant[]; pagination: AccountPagination };
export type AccountPagination = AccountValue<Pagination>;
export type AccountSpace = AccountValue<GeneratedSpace>;
export type AccountSpacePage = { spaces: AccountSpace[]; pagination: AccountPagination };

let csrfToken: string | undefined;
let csrfExpiresAt = 0;
const CSRF_REFRESH_MS = 55 * 60 * 1000;

export class AccountAPIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AccountAPIError";
  }
}

type AccountEffectClient = Effect.Success<ReturnType<typeof createChalkEffectClient>>;

export async function registerAccount(input: { name: string; email: string; password: string }): Promise<AccountUser> {
  const response = await dashboardRequest<{ user: AccountUser }>("/api/auth/register", {
    method: "POST",
    body: input,
  });
  return response.user;
}

export async function loginAccount(input: { email: string; password: string }): Promise<AccountUser> {
  const response = await dashboardRequest<{ user: AccountUser }>("/api/auth/login", {
    method: "POST",
    body: input,
  });
  return response.user;
}

export async function requestPasswordReset(email: string): Promise<void> {
  await dashboardRequest("/api/auth/password-reset/request", { method: "POST", body: { email } });
}

export async function completePasswordReset(input: { token: string; password: string }): Promise<void> {
  await dashboardRequest("/api/auth/password-reset/complete", { method: "POST", body: input });
}

export async function logoutAccount(): Promise<void> {
  await dashboardRequest("/api/auth/logout", { method: "POST", body: {} });
  csrfToken = undefined;
  csrfExpiresAt = 0;
}

export function getAccount(): Promise<AccountUser> {
  return generatedRequest((client) => client.me.getMe());
}

function listAccountTenants(options: { cursor?: string; pageSize?: number } = {}): Promise<AccountTenantPage> {
  return generatedRequest((client) =>
    client.tenants.listMyTenants({
      query: { cursor: options.cursor, page_size: options.pageSize },
    }),
  );
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

export function listSpaces(input: { tenantID: string; cursor?: string; pageSize?: number; archived?: boolean }): Promise<AccountSpacePage> {
  return generatedRequest((client) =>
    client.spaces.listSpaces({
      params: { tenant_id: input.tenantID as GeneratedTenant["id"] },
      query: { cursor: input.cursor, page_size: input.pageSize, archived: input.archived },
    }),
  );
}

export function acceptTenantInvitation(token: string) {
  return generatedRequest((client) => client.tenants.acceptTenantInvitation({ payload: { token } }));
}

type AccountRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: HeadersInit;
};

type AccountRequestCorrelation = {
  journeyID: string;
  traceparent: string;
  responseStatus?: number;
  endpoint?: string;
};

async function createAccountEffectClient(correlation: AccountRequestCorrelation): Promise<AccountEffectClient> {
  const transport = dashboardTransport(correlation);
  return Effect.runPromise(
    createChalkEffectClient({
      baseUrl: window.location.origin,
      fetch: transport,
    }),
  );
}

async function generatedRequest<A, E = never>(operation: (client: AccountEffectClient) => Effect.Effect<A, E>, correlation = newAccountRequestCorrelation()): Promise<AccountValue<A>> {
  try {
    const client = await createAccountEffectClient(correlation);
    return dashboardValue(await Effect.runPromise(operation(client)));
  } catch (cause) {
    throw dashboardEffectError(cause, correlation.responseStatus, correlation);
  }
}

function dashboardValue<T>(value: T): AccountValue<T> {
  if (Array.isArray(value)) return value.map((item) => dashboardValue(item)) as AccountValue<T>;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, dashboardValue(child)])) as AccountValue<T>;
  return value as AccountValue<T>;
}

function dashboardTransport(correlation: AccountRequestCorrelation): typeof globalThis.fetch {
  const requestFetch = globalThis.fetch.bind(globalThis);
  const send = async (input: RequestInfo | URL, init: RequestInit = {}, retryCSRF = true): Promise<Response> => {
    const sourceURL = new URL(input instanceof Request ? input.url : input.toString(), window.location.origin);
    const targetURL = new URL(sourceURL);
    if (targetURL.pathname.startsWith("/v1")) targetURL.pathname = `/api${targetURL.pathname.slice(3)}`;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("X-Chalk-Journey-ID", correlation.journeyID);
    headers.set("Traceparent", correlation.traceparent);
    if (method !== "GET") headers.set("X-Chalk-CSRF", await getCSRFToken());
    const body = dashboardTransportBody(targetURL, method, init.body);
    if (method !== "GET" && body !== undefined) headers.set("Content-Type", "application/json");
    const targetInput = targetURL.origin === window.location.origin ? `${targetURL.pathname}${targetURL.search}` : targetURL;
    const response = await requestFetch(targetInput, {
      ...init,
      credentials: "same-origin",
      headers,
      body,
    });
    correlation.responseStatus = response.status;
    correlation.endpoint = `${method} ${boundedEndpointPath(targetURL.pathname)}`;
    if (retryCSRF && (await retryableCSRFResponse(response, method))) {
      csrfToken = undefined;
      csrfExpiresAt = 0;
      return send(input, init, false);
    }
    return response;
  };
  return (input, init = {}) => send(input, init);
}

function dashboardTransportBody(targetURL: URL, method: string, body: RequestInit["body"]): RequestInit["body"] {
  if (method !== "GET" && body === undefined) return "{}";
  const text = requestBodyText(body);
  if (method !== "PATCH" || !targetURL.pathname.includes("/spaces/") || text === undefined) return body;
  try {
    return JSON.stringify(normalizeUpdateSpaceBody(JSON.parse(text)));
  } catch {
    return body;
  }
}

function requestBodyText(body: RequestInit["body"]): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return undefined;
}

const SPACE_DURATION_FIELDS = new Set(["default_episode_duration_seconds", "maximum_episode_duration_seconds", "linger_window_seconds"]);

function normalizeUpdateSpaceBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) => {
      if (!SPACE_DURATION_FIELDS.has(key) || !isRecord(field)) return [[key, field]];
      return field.Set === true ? [[key, field.Value ?? null]] : [];
    }),
  );
}

async function retryableCSRFResponse(response: Response, method: string): Promise<boolean> {
  if (method === "GET" || response.status !== 403) return false;
  try {
    const value: unknown = await response.clone().json();
    const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
    return normalizeAccountErrorCode(error ? stringValue(error.code) : undefined) === "csrf.mismatch";
  } catch {
    return false;
  }
}

function dashboardEffectError(cause: unknown, responseStatus?: number, correlation?: AccountRequestCorrelation): AccountAPIError {
  const apiError = apiErrorFields(cause);
  if (apiError) return new AccountAPIError(effectErrorStatus(cause) ?? responseStatus ?? 500, apiError.code, apiError.message);
  const status = effectErrorStatus(cause) ?? responseStatus;
  if (status !== undefined && status >= 200 && status < 300) {
    reportContractMismatch(cause, correlation);
    return new AccountAPIError(502, "response.invalid", "Response did not match the expected contract");
  }
  return new AccountAPIError(status ?? 500, "request.failed", "Request failed");
}

/** Path segments that hold identifiers become `:id` so the endpoint is safe to log and groups by route. */
function boundedEndpointPath(pathname: string): string {
  return pathname.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, "/:id");
}

/** Names the endpoint and the first failing field. Received values stay out because they can be personal data. */
function reportContractMismatch(cause: unknown, correlation?: AccountRequestCorrelation): void {
  const failure = Schema.isSchemaError(cause) ? SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue).issues[0] : undefined;
  const path = failure?.path?.map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment))).join(".");
  console.warn("dashboard response did not match the expected contract", {
    endpoint: correlation?.endpoint,
    status: correlation?.responseStatus,
    failing_path: path ?? "unknown",
    journey_id: correlation?.journeyID,
  });
}

function apiErrorFields(value: unknown): { code: string; message: string } | undefined {
  if (!isRecord(value)) return undefined;
  const nested = isRecord(value.error) ? value.error : value;
  const code = stringValue(nested.code);
  const message = stringValue(nested.message);
  return code && message && code.includes(".") ? { code, message } : undefined;
}

function effectErrorStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status === "number") return value.status;
  if (!isRecord(value.reason) || !isRecord(value.reason.response)) return undefined;
  return typeof value.reason.response.status === "number" ? value.reason.response.status : undefined;
}

async function dashboardRequest<T = unknown>(path: string, options: AccountRequestOptions = {}, retryCSRF = true, correlation: AccountRequestCorrelation = newAccountRequestCorrelation()): Promise<T> {
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
    const rawCode = stringValue(error.code);
    const code = normalizeAccountErrorCode(rawCode);
    if (retryCSRF && method !== "GET" && response.status === 403 && code === "csrf.mismatch") {
      csrfToken = undefined;
      csrfExpiresAt = 0;
      return dashboardRequest(path, options, false, correlation);
    }
    throw new AccountAPIError(response.status, code, stringValue(error.message) ?? "Request failed");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function normalizeAccountErrorCode(code: string | undefined): string {
  if (code === "csrf_mismatch") return "csrf.mismatch";
  if (code === "upstream_unavailable") return "request.failed";
  if (code && code.includes(".")) return code;
  return "request.failed";
}

function newAccountRequestCorrelation(): AccountRequestCorrelation {
  return { journeyID: crypto.randomUUID(), traceparent: newTraceparent() };
}

async function getCSRFToken(): Promise<string> {
  if (csrfToken && Date.now() < csrfExpiresAt) return csrfToken;
  const response = await fetch("/api/auth/csrf", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new AccountAPIError(response.status, "csrf.unavailable", "Could not secure this request");
  const value = (await response.json()) as { csrf_token?: unknown };
  if (typeof value.csrf_token !== "string") throw new AccountAPIError(502, "csrf.unavailable", "Could not secure this request");
  csrfToken = value.csrf_token;
  csrfExpiresAt = Date.now() + CSRF_REFRESH_MS;
  return csrfToken;
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
