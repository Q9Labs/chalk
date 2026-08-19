import { Effect } from "effect";
import type { FeedbackReportReceiptV1, FeedbackReportRequestV1 } from "@q9labsai/chalk-client";
import {
  createChalkEffectClient,
  type APIKeyList,
  type APIKeyWithSecret,
  type AccountTenantList,
  type AuthUser,
  type DateTimeString,
  type Episode,
  type EpisodeEnd,
  type Pagination,
  type RecentAuth,
  type RecentAuthGoogleStart as GeneratedRecentAuthGoogleStart,
  type Regions,
  type Space as GeneratedSpace,
  type Tenant as GeneratedTenant,
} from "@q9labsai/chalk-client/effect";

type DashboardValue<T> = T extends string ? string : T extends readonly (infer Item)[] ? DashboardValue<Item>[] : T extends object ? { -readonly [Key in keyof T]: DashboardValue<T[Key]> } : T;
export type DashboardAccount = DashboardValue<AuthUser>;
export type Tenant = DashboardValue<GeneratedTenant>;
export type TenantAccess = DashboardValue<AccountTenantList["tenants"][number]["access"]>;
export type AccountTenant = { tenant: Tenant; access: TenantAccess };
type AccountTenantPage = { tenants: AccountTenant[]; pagination: DashboardPagination };
export type Region = DashboardValue<Regions["regions"][number]>;
export type DashboardPagination = DashboardValue<Pagination>;
export type DashboardSpace = DashboardValue<GeneratedSpace>;
export type Space = DashboardSpace;
export type DashboardSpacePage = { spaces: DashboardSpace[]; pagination: DashboardPagination };
export type DashboardEpisode = Omit<DashboardValue<Episode>, "ended_at"> & { ended_at?: string | null };
export type DashboardEpisodePage = { episodes: DashboardEpisode[]; pagination: DashboardPagination };
export type DashboardAPIKey = DashboardValue<APIKeyList["api_keys"][number]>;
export type DashboardAPIKeyPage = { api_keys: DashboardAPIKey[]; pagination: DashboardPagination };
export type APIKeySecretResult = Omit<DashboardValue<APIKeyWithSecret>, "replayed"> & { replayed?: boolean };

export function defaultSpaceMediaPlane(): "cf_rtk" | "cf_sfu" {
  const configured = (import.meta as ImportMeta & { readonly env?: Record<string, unknown> }).env?.VITE_CHALK_DEV_MEDIA_PLANE;
  return configured === "cf_sfu" ? "cf_sfu" : "cf_rtk";
}

type LocalTenantMediaPlaneConfig = {
  readonly default_media_plane: "cf_sfu";
  readonly media_plane_provider_config: {
    readonly enabled: true;
    readonly provider: "cf_sfu";
    readonly mode: "chalk_managed";
  };
};

export function localTenantMediaPlaneConfig(): LocalTenantMediaPlaneConfig | undefined {
  if (defaultSpaceMediaPlane() !== "cf_sfu") return undefined;
  return {
    default_media_plane: "cf_sfu",
    media_plane_provider_config: { enabled: true, provider: "cf_sfu", mode: "chalk_managed" },
  };
}

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
    this.name = "DashboardAPIError";
  }
}

type DashboardEffectClient = Effect.Success<ReturnType<typeof createChalkEffectClient>>;

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

export function submitFeedbackReport(tenantID: string, input: FeedbackReportRequestV1, idempotencyKey: string): Promise<FeedbackReportReceiptV1> {
  return dashboardRequest<FeedbackReportReceiptV1>(`/api/tenants/${tenantID}/feedback-reports`, { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: input });
}

export function getAccount(): Promise<DashboardAccount> {
  return generatedRequest((client) => client.me.getMe());
}

function listAccountTenants(options: { cursor?: string; pageSize?: number } = {}): Promise<AccountTenantPage> {
  return generatedRequest((client) => client.tenants.listMyTenants({ query: { cursor: options.cursor, page_size: options.pageSize } }));
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
  const response = await generatedRequest((client) => client.regions.listRegions());
  return response.regions.map(({ code, name }) => ({ code, name }));
}

export async function onboardTenant(input: { name: string; default_region: string }): Promise<AccountTenant> {
  const fingerprint = JSON.stringify({ name: input.name.trim(), default_region: input.default_region });
  const requestKey = tenantOnboardingRequestKey(fingerprint);
  const response = await generatedRequest((client) => client.tenants.onboardTenant({ headers: { "Idempotency-Key": requestKey }, payload: input }));
  const tenant = (await configureLocalTenantMediaPlane(response.tenant.id)) ?? response.tenant;
  window.localStorage.removeItem("chalk.tenant-onboarding-request");
  return { tenant: tenant as Tenant, access: response.access as TenantAccess };
}

export function listSpaces(input: { tenantID: string; cursor?: string; pageSize?: number; archived?: boolean }): Promise<DashboardSpacePage> {
  return generatedRequest((client) => client.spaces.listSpaces({ params: { tenant_id: input.tenantID as GeneratedTenant["id"] }, query: { cursor: input.cursor, page_size: input.pageSize, archived: input.archived } }));
}

export function getSpace(input: { tenantID: string; spaceID: string }): Promise<DashboardSpace> {
  return generatedRequest((client) => client.spaces.getSpace({ params: { tenant_id: input.tenantID as GeneratedTenant["id"], space_id: input.spaceID as GeneratedSpace["id"] } }));
}

export async function createSpace(input: {
  tenantID: string;
  name: string;
  slug: string;
  media_plane?: string;
  metadata?: unknown;
  recurring_policy?: unknown;
  admission_policy?: unknown;
  default_episode_duration_seconds?: number;
  maximum_episode_duration_seconds?: number;
  linger_window_seconds?: number;
}): Promise<DashboardSpace> {
  const { tenantID, ...values } = input;
  await configureLocalTenantMediaPlane(tenantID);
  const body = {
    media_plane: defaultSpaceMediaPlane(),
    default_episode_duration_seconds: 86_400,
    maximum_episode_duration_seconds: 86_400,
    linger_window_seconds: 0,
    ...values,
  };
  const request = mutationRequestKey("space-create", JSON.stringify({ tenantID, body }));
  const space = await generatedRequest((client) => client.spaces.createSpace({ params: { tenant_id: tenantID as GeneratedTenant["id"] }, headers: { "Idempotency-Key": request.key }, payload: body }));
  clearMutationRequestKey(request.storageKey);
  return space;
}

async function configureLocalTenantMediaPlane(tenantID: string): Promise<Tenant | undefined> {
  const localMediaPlane = localTenantMediaPlaneConfig();
  if (!localMediaPlane) return undefined;
  return (await generatedRequest((client) => client.tenants.updateTenant({ params: { tenant_id: tenantID as GeneratedTenant["id"] }, payload: localMediaPlane }))) as Tenant;
}

export function updateSpace(input: {
  tenantID: string;
  spaceID: string;
  name?: string;
  slug?: string;
  media_plane?: string;
  metadata?: unknown;
  recurring_policy?: unknown;
  admission_policy?: unknown;
  default_episode_duration_seconds?: number | null;
  maximum_episode_duration_seconds?: number | null;
  linger_window_seconds?: number | null;
}): Promise<DashboardSpace> {
  const { tenantID, spaceID, ...body } = input;
  return generatedRequest((client) => client.spaces.updateSpace({ params: { tenant_id: tenantID as GeneratedTenant["id"], space_id: spaceID as GeneratedSpace["id"] }, payload: updateSpacePayload(body) }));
}

export function archiveSpace(input: { tenantID: string; spaceID: string }): Promise<DashboardSpace> {
  return generatedRequest((client) => client.spaces.archiveSpace({ params: { tenant_id: input.tenantID as GeneratedTenant["id"], space_id: input.spaceID as GeneratedSpace["id"] } }));
}

export function restoreSpace(input: { tenantID: string; spaceID: string }): Promise<DashboardSpace> {
  return generatedRequest((client) => client.spaces.restoreSpace({ params: { tenant_id: input.tenantID as GeneratedTenant["id"], space_id: input.spaceID as GeneratedSpace["id"] } }));
}

export async function listEpisodes(input: { tenantID: string; spaceID?: string; cursor?: string; pageSize?: number }): Promise<DashboardEpisodePage> {
  if (input.spaceID) return listSpaceEpisodes({ ...input, spaceID: input.spaceID });

  return listTenantEpisodes(input);
}

export function getEpisode(input: { tenantID: string; spaceID: string; episodeID: string }): Promise<DashboardEpisode> {
  return generatedRequest((client) => client.episodes.getEpisode({ params: episodeParams(input) }));
}

export async function createEpisode(input: { tenantID: string; spaceID: string; metadata?: unknown; started_at?: string }): Promise<DashboardEpisode> {
  const { tenantID, spaceID, ...body } = input;
  const fingerprint = JSON.stringify({ tenantID, spaceID, body });
  const request = mutationRequestKey("episode-create", fingerprint);
  const episode = await generatedRequest((client) =>
    client.episodes.createEpisode({ params: { tenant_id: tenantID as GeneratedTenant["id"], space_id: spaceID as GeneratedSpace["id"] }, headers: { "Idempotency-Key": request.key }, payload: { ...body, started_at: body.started_at as Episode["started_at"] } }),
  );
  clearMutationRequestKey(request.storageKey);
  return episode;
}

export async function endEpisode(input: { tenantID: string; spaceID: string; episodeID: string }): Promise<DashboardValue<EpisodeEnd>> {
  const fingerprint = episodeEndFingerprint(input);
  const request = mutationRequestKey("episode-end", fingerprint);
  const result = await generatedRequest((client) => client.episodes.endEpisode({ params: episodeParams(input), headers: { "Idempotency-Key": request.key } }));
  if (!episodeEndStillPending(result)) clearMutationRequestKey(request.storageKey);
  return result;
}

export function clearEpisodeEndRequest(input: { tenantID: string; spaceID: string; episodeID: string }): void {
  const storageKey = mutationStorageKey("episode-end");
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as { fingerprint?: unknown } | null;
    if (stored?.fingerprint === episodeEndFingerprint(input)) clearMutationRequestKey(storageKey);
  } catch {
    // A malformed retry record is safe to leave until the next attempt replaces it.
  }
}

function episodeEndFingerprint(input: { tenantID: string; spaceID: string; episodeID: string }): string {
  return JSON.stringify({ tenantID: input.tenantID, spaceID: input.spaceID, episodeID: input.episodeID });
}

export function listAPIKeys(tenantID: string, options: { cursor?: string; pageSize?: number } = {}): Promise<DashboardAPIKeyPage> {
  return generatedRequest((client) => client.default.listAPIKeys({ params: { tenant_id: tenantID as GeneratedTenant["id"] }, query: { cursor: options.cursor, page_size: options.pageSize } }));
}

export async function createAPIKey(tenantID: string, input: { name: string; scopes: string[]; expires_at: string }, options: { idempotencyKey?: string; recentAuth?: string } = {}): Promise<APIKeySecretResult> {
  const requestKey = options.idempotencyKey ?? crypto.randomUUID().replaceAll("-", "");
  return generatedRequest((client) => client.default.createAPIKey({ params: { tenant_id: tenantID as GeneratedTenant["id"] }, headers: requiredAPIKeyHeaders(requestKey, options.recentAuth), payload: { ...input, expires_at: input.expires_at as DateTimeString } }));
}

export async function rotateAPIKey(tenantID: string, keyID: string, input: { expires_at?: string } = {}, options: { idempotencyKey?: string; recentAuth?: string } = {}): Promise<APIKeySecretResult> {
  const requestKey = options.idempotencyKey ?? crypto.randomUUID().replaceAll("-", "");
  return generatedRequest((client) =>
    client.default.rotateAPIKey({ params: { tenant_id: tenantID as GeneratedTenant["id"], api_key_id: keyID as APIKeyList["api_keys"][number]["id"] }, headers: requiredAPIKeyHeaders(requestKey, options.recentAuth), payload: { ...input, expires_at: input.expires_at as DateTimeString } }),
  );
}

export function revokeAPIKey(tenantID: string, keyID: string, options: { recentAuth?: string } = {}): Promise<void> {
  return generatedRequest((client) => client.default.revokeAPIKey({ params: { tenant_id: tenantID as GeneratedTenant["id"], api_key_id: keyID as APIKeyList["api_keys"][number]["id"] }, headers: recentAPIKeyHeaders(options.recentAuth) }));
}

export function createRecentAuthProof(input: { password: string; action: string; resource_id?: string }): Promise<RecentAuthProof> {
  return dashboardRequest("/api/me/recent-auth", { method: "POST", body: input });
}

export type RecentAuthGoogleStart = DashboardValue<GeneratedRecentAuthGoogleStart>;
export type RecentAuthProof = DashboardValue<RecentAuth>;

function updateSpacePayload(input: {
  name?: string;
  slug?: string;
  media_plane?: string;
  metadata?: unknown;
  recurring_policy?: unknown;
  admission_policy?: unknown;
  default_episode_duration_seconds?: number | null;
  maximum_episode_duration_seconds?: number | null;
  linger_window_seconds?: number | null;
}) {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.slug === undefined ? {} : { slug: input.slug }),
    ...(input.media_plane === undefined ? {} : { media_plane: input.media_plane }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.recurring_policy === undefined ? {} : { recurring_policy: input.recurring_policy }),
    ...(input.admission_policy === undefined ? {} : { admission_policy: input.admission_policy }),
    default_episode_duration_seconds: optionalSpaceNumber(input.default_episode_duration_seconds),
    maximum_episode_duration_seconds: optionalSpaceNumber(input.maximum_episode_duration_seconds),
    linger_window_seconds: optionalSpaceNumber(input.linger_window_seconds),
  };
}

function optionalSpaceNumber(value: number | null | undefined): { Set: boolean; Value?: number | null } {
  return value === undefined ? { Set: false } : { Set: true, Value: value };
}

function episodeParams(input: { tenantID: string; spaceID: string; episodeID: string }) {
  return { tenant_id: input.tenantID as GeneratedTenant["id"], space_id: input.spaceID as GeneratedSpace["id"], episode_id: input.episodeID as Episode["id"] };
}

function requiredAPIKeyHeaders(idempotencyKey: string, recentAuth: string | undefined) {
  return { "Idempotency-Key": idempotencyKey, "X-Chalk-Recent-Auth": recentAuth ?? "" };
}

function recentAPIKeyHeaders(recentAuth: string | undefined) {
  return { "X-Chalk-Recent-Auth": recentAuth ?? "" };
}

export function startRecentAuthGoogle(input: { action: string; resource_id?: string }): Promise<RecentAuthGoogleStart> {
  const query = new URLSearchParams({ action: input.action });
  if (input.resource_id) query.set("resource_id", input.resource_id);
  return dashboardRequest(`/api/me/recent-auth/google/start?${query.toString()}`);
}

export function completeRecentAuthGoogle(input: { state: string; code: string }): Promise<RecentAuthProof> {
  const query = new URLSearchParams({ state: input.state, code: input.code });
  return dashboardRequest(`/api/me/recent-auth/google/callback?${query.toString()}`);
}

type DashboardRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: HeadersInit;
};

type DashboardRequestCorrelation = {
  journeyID: string;
  traceparent: string;
  responseStatus?: number;
};

async function createDashboardEffectClient(correlation: DashboardRequestCorrelation): Promise<DashboardEffectClient> {
  const transport = dashboardTransport(correlation);
  return Effect.runPromise(
    createChalkEffectClient({
      baseUrl: window.location.origin,
      fetch: transport,
    }),
  );
}

async function generatedRequest<A, E = never>(operation: (client: DashboardEffectClient) => Effect.Effect<A, E>, correlation = newDashboardRequestCorrelation()): Promise<DashboardValue<A>> {
  try {
    const client = await createDashboardEffectClient(correlation);
    return dashboardValue(await Effect.runPromise(operation(client)));
  } catch (cause) {
    throw dashboardEffectError(cause, correlation.responseStatus);
  }
}

function dashboardValue<T>(value: T): DashboardValue<T> {
  if (Array.isArray(value)) return value.map((item) => dashboardValue(item)) as DashboardValue<T>;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, dashboardValue(child)])) as DashboardValue<T>;
  return value as DashboardValue<T>;
}

function dashboardTransport(correlation: DashboardRequestCorrelation): typeof globalThis.fetch {
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
    const response = await requestFetch(targetInput, { ...init, credentials: "same-origin", headers, body });
    correlation.responseStatus = response.status;
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
    return normalizeDashboardErrorCode(error ? stringValue(error.code) : undefined) === "csrf.mismatch";
  } catch {
    return false;
  }
}

function dashboardEffectError(cause: unknown, responseStatus?: number): DashboardAPIError {
  const apiError = apiErrorFields(cause);
  if (apiError) return new DashboardAPIError(effectErrorStatus(cause) ?? responseStatus ?? 500, apiError.code, apiError.message);
  const status = effectErrorStatus(cause) ?? responseStatus;
  if (status !== undefined && status >= 200 && status < 300) return new DashboardAPIError(502, "response.invalid", "Response did not match the expected contract");
  return new DashboardAPIError(status ?? 500, "request.failed", "Request failed");
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
    const rawCode = stringValue(error.code);
    const code = normalizeDashboardErrorCode(rawCode);
    if (retryCSRF && method !== "GET" && response.status === 403 && code === "csrf.mismatch") {
      csrfToken = undefined;
      csrfExpiresAt = 0;
      return dashboardRequest(path, options, false, correlation);
    }
    throw new DashboardAPIError(response.status, code, stringValue(error.message) ?? "Request failed");
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function normalizeDashboardErrorCode(code: string | undefined): string {
  if (code === "csrf_mismatch") return "csrf.mismatch";
  if (code === "upstream_unavailable") return "request.failed";
  if (code && code.includes(".")) return code;
  return "request.failed";
}

async function listSpaceEpisodes(input: { tenantID: string; spaceID: string; cursor?: string; pageSize?: number }): Promise<DashboardEpisodePage> {
  return generatedRequest((client) => client.episodes.listEpisodes({ params: { tenant_id: input.tenantID as GeneratedTenant["id"], space_id: input.spaceID as GeneratedSpace["id"] }, query: { cursor: input.cursor, page_size: input.pageSize } }));
}

/**
 * The API currently exposes episode history per Space, not at the Tenant
 * boundary. Keep the client-side fan-out bounded and carry each source's
 * native cursor/offset forward in an opaque composite cursor. This preserves
 * page-size/cursor semantics without pretending that all history was loaded.
 */
const TENANT_EPISODE_SPACE_PAGE_SIZE = 24;
// Tenant-wide ordering is only truthful when every Space has participated in
// the merge. Refuse larger tenants instead of returning pages that are ordered
// only within an arbitrary Space window.
const TENANT_EPISODE_MAX_SPACES = 120;
const TENANT_EPISODE_MAX_SPACE_PAGES = 8;
const TENANT_EPISODE_DEFAULT_PAGE_SIZE = 25;
const TENANT_EPISODE_MAX_PAGE_SIZE = 100;

type CompositeEpisodeStream = {
  space_id: string;
  cursor: string | null;
  offset: number;
  exhausted: boolean;
};

type CompositeEpisodeCursor = {
  version: 1;
  tenant_id: string;
  page_size: number;
  space_cursor: string | null;
  spaces_exhausted: boolean;
  streams: CompositeEpisodeStream[];
};

type EpisodeCandidate = { episode: DashboardEpisode; streamID: string };

async function listTenantEpisodes(input: { tenantID: string; cursor?: string; pageSize?: number }): Promise<DashboardEpisodePage> {
  const pageSize = boundedEpisodePageSize(input.pageSize);
  const state = input.cursor ? decodeCompositeEpisodeCursor(input.cursor) : undefined;
  if (state && (state.tenant_id !== input.tenantID || state.page_size !== pageSize)) {
    throw new DashboardAPIError(400, "request.invalid_cursor", "Episode history cursor does not match this request");
  }

  let spacesExhausted = state?.spaces_exhausted ?? false;
  let streams = state?.streams ?? [];

  // Discover the complete bounded Space set before reading any Episode page.
  // This is what makes the timestamp merge globally ordered, including when a
  // Tenant has more than one Space-list page.
  if (!state) {
    const spaces = await listTenantEpisodeSpaces(input.tenantID);
    streams = spaces.map((space) => ({ space_id: space.id, cursor: null, offset: 0, exhausted: false }));
    spacesExhausted = true;
  } else if (streams.length === 0 && !spacesExhausted) {
    throw new DashboardAPIError(400, "request.invalid_cursor", "Episode history cursor is invalid");
  }

  if (streams.length === 0) {
    return { episodes: [], pagination: { page_size: pageSize, next_cursor: null, has_more: false } };
  }

  const activeStreams = streams.filter((stream) => !stream.exhausted);
  const streamPages = await Promise.all(
    activeStreams.map(async (stream) => ({
      stream,
      page: await listSpaceEpisodes({
        tenantID: input.tenantID,
        spaceID: stream.space_id,
        cursor: stream.cursor ?? undefined,
        pageSize,
      }),
    })),
  );
  const candidates = streamPages.flatMap(({ stream, page }) => page.episodes.slice(stream.offset).map((episode) => ({ episode, streamID: stream.space_id })));
  candidates.sort(compareEpisodeCandidates);
  const selected = candidates.slice(0, pageSize);
  const consumedByStream = new Map<string, number>();
  for (const candidate of selected) consumedByStream.set(candidate.streamID, (consumedByStream.get(candidate.streamID) ?? 0) + 1);

  const loadedPages = new Map(streamPages.map(({ stream, page }) => [stream.space_id, { stream, page }]));
  streams = streams.map((stream) => {
    if (stream.exhausted) return stream;
    const loaded = loadedPages.get(stream.space_id);
    if (!loaded) return stream;
    const consumed = consumedByStream.get(stream.space_id) ?? 0;
    const nextOffset = stream.offset + consumed;
    if (nextOffset < loaded.page.episodes.length) return { ...stream, offset: nextOffset };
    if (loaded.page.pagination.has_more && loaded.page.pagination.next_cursor) {
      return { ...stream, cursor: loaded.page.pagination.next_cursor, offset: 0 };
    }
    return { ...stream, cursor: null, offset: 0, exhausted: true };
  });

  const hasMoreStreams = streams.some((stream) => !stream.exhausted);
  const hasMoreSpaces = false;
  const hasMore = hasMoreStreams || hasMoreSpaces;
  const nextCursor = hasMore
    ? encodeCompositeEpisodeCursor({
        version: 1,
        tenant_id: input.tenantID,
        page_size: pageSize,
        space_cursor: null,
        spaces_exhausted: spacesExhausted,
        streams: hasMoreStreams ? streams : [],
      })
    : null;

  return {
    episodes: selected.map(({ episode }) => episode),
    pagination: { page_size: pageSize, next_cursor: nextCursor, has_more: hasMore },
  };
}

async function listTenantEpisodeSpaces(tenantID: string): Promise<DashboardSpace[]> {
  const spaces: DashboardSpace[] = [];
  let cursor: string | undefined;
  let pagesRead = 0;
  while (true) {
    const page = await listSpaces({ tenantID, cursor, pageSize: TENANT_EPISODE_SPACE_PAGE_SIZE });
    pagesRead += 1;
    spaces.push(...page.spaces);
    if (spaces.length > TENANT_EPISODE_MAX_SPACES || (pagesRead >= TENANT_EPISODE_MAX_SPACE_PAGES && page.pagination.has_more)) {
      throw new DashboardAPIError(413, "episode.history_too_large", `Tenant-wide Episode history supports up to ${TENANT_EPISODE_MAX_SPACES} Spaces.`);
    }
    if (!page.pagination.has_more) return spaces;
    const nextCursor = page.pagination.next_cursor;
    if (!nextCursor || nextCursor === cursor) throw new DashboardAPIError(502, "pagination.invalid", "The Spaces history cursor was invalid.");
    cursor = nextCursor;
  }
}

function boundedEpisodePageSize(pageSize: number | undefined): number {
  const requested = pageSize === undefined || !Number.isFinite(pageSize) ? TENANT_EPISODE_DEFAULT_PAGE_SIZE : pageSize;
  return Math.min(Math.max(Math.floor(requested), 1), TENANT_EPISODE_MAX_PAGE_SIZE);
}

function compareEpisodeCandidates(left: EpisodeCandidate, right: EpisodeCandidate): number {
  const leftTime = Date.parse(left.episode.started_at);
  const rightTime = Date.parse(right.episode.started_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left.episode.id !== right.episode.id) return left.episode.id.localeCompare(right.episode.id);
  return left.streamID.localeCompare(right.streamID);
}

function encodeCompositeEpisodeCursor(value: CompositeEpisodeCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCompositeEpisodeCursor(cursor: string): CompositeEpisodeCursor {
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (cursor.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (isCompositeEpisodeCursor(value)) return value;
  } catch {
    // Fall through to the stable client error below.
  }
  throw new DashboardAPIError(400, "request.invalid_cursor", "Episode history cursor is invalid");
}

function isCompositeEpisodeCursor(value: unknown): value is CompositeEpisodeCursor {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.tenant_id !== "string" ||
    typeof value.page_size !== "number" ||
    !Number.isInteger(value.page_size) ||
    value.page_size < 1 ||
    value.page_size > TENANT_EPISODE_MAX_PAGE_SIZE ||
    (typeof value.space_cursor !== "string" && value.space_cursor !== null) ||
    typeof value.spaces_exhausted !== "boolean" ||
    !Array.isArray(value.streams) ||
    value.streams.length > TENANT_EPISODE_SPACE_PAGE_SIZE
  ) {
    return false;
  }
  return value.streams.every((stream) => isRecord(stream) && typeof stream.space_id === "string" && (typeof stream.cursor === "string" || stream.cursor === null) && typeof stream.offset === "number" && Number.isInteger(stream.offset) && stream.offset >= 0 && typeof stream.exhausted === "boolean");
}

function mutationRequestKey(action: string, fingerprint: string): { key: string; storageKey: string } {
  const storageKey = mutationStorageKey(action);
  try {
    const existing = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as { fingerprint?: unknown; key?: unknown } | null;
    if (existing?.fingerprint === fingerprint && typeof existing.key === "string") return { key: existing.key, storageKey };
  } catch {
    // Replace malformed retry metadata below.
  }
  const key = crypto.randomUUID().replaceAll("-", "");
  window.localStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
  return { key, storageKey };
}

function mutationStorageKey(action: string): string {
  return `chalk.dashboard-request.${action}`;
}

function episodeEndStillPending(value: unknown): boolean {
  if (!isRecord(value)) return true;
  return stringValue(value.status) !== "ended";
}

function clearMutationRequestKey(storageKey: string): void {
  window.localStorage.removeItem(storageKey);
}

function newDashboardRequestCorrelation(): DashboardRequestCorrelation {
  return { journeyID: crypto.randomUUID(), traceparent: newTraceparent() };
}

async function getCSRFToken(): Promise<string> {
  if (csrfToken && Date.now() < csrfExpiresAt) return csrfToken;
  const response = await fetch("/api/auth/csrf", { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!response.ok) throw new DashboardAPIError(response.status, "csrf.unavailable", "Could not secure this request");
  const value = (await response.json()) as { csrf_token?: unknown };
  if (typeof value.csrf_token !== "string") throw new DashboardAPIError(502, "csrf.unavailable", "Could not secure this request");
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
