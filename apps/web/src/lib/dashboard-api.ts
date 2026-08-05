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

export type DashboardPagination = { page_size: number; next_cursor: string | null; has_more: boolean };

export type DashboardSpace = {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  media_plane: string;
  metadata: unknown;
  recurring_policy: unknown;
  admission_policy: unknown;
  default_episode_duration_seconds: number;
  maximum_episode_duration_seconds: number;
  linger_window_seconds: number;
  archived: boolean;
  archived_at: string | null;
  roles: { id: string; name: string; capabilities: string[] }[];
  created_by_user_id: string | null;
  updated_at: string;
  created_at: string;
};

export type DashboardSpacePage = { spaces: DashboardSpace[]; pagination: DashboardPagination };
export type Space = DashboardSpace;

export type DashboardEpisode = {
  id: string;
  tenant_id: string;
  space_id: string;
  status: "active" | "ending" | "ended";
  metadata: unknown;
  config_snapshot: unknown;
  end_reason?: string | null;
  started_at: string;
  ended_at?: string | null;
  deadline_at: string;
  deadline_generation: number;
  updated_at: string;
  created_at: string;
};

export type DashboardEpisodePage = { episodes: DashboardEpisode[]; pagination: DashboardPagination };

export type DashboardAPIKey = {
  id: string;
  tenant_id: string;
  name: string;
  scopes: string[];
  key_prefix: string;
  created_by_user_id: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string;
  updated_at: string;
  created_at: string;
};

export type DashboardAPIKeyPage = { api_keys: DashboardAPIKey[]; pagination: DashboardPagination };
export type APIKeySecretResult = { api_key: DashboardAPIKey; secret: string };

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

export function listSpaces(input: { tenantID: string; cursor?: string; pageSize?: number; archived?: boolean }): Promise<DashboardSpacePage> {
  return dashboardRequest(`/api/tenants/${encodeURIComponent(input.tenantID)}/spaces${paginationSearch(input)}`);
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
  const body = {
    media_plane: "cf_rtk",
    default_episode_duration_seconds: 86_400,
    maximum_episode_duration_seconds: 86_400,
    linger_window_seconds: 0,
    ...values,
  };
  const request = mutationRequestKey("space-create", JSON.stringify({ tenantID, body }));
  const space = await dashboardRequest<DashboardSpace>(`/api/tenants/${encodeURIComponent(tenantID)}/spaces`, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": request.key },
  });
  clearMutationRequestKey(request.storageKey);
  return space;
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
  default_episode_duration_seconds?: number;
  maximum_episode_duration_seconds?: number;
  linger_window_seconds?: number;
}): Promise<DashboardSpace> {
  const { tenantID, spaceID, ...body } = input;
  return dashboardRequest(`/api/tenants/${encodeURIComponent(tenantID)}/spaces/${encodeURIComponent(spaceID)}`, { method: "PATCH", body });
}

export function archiveSpace(input: { tenantID: string; spaceID: string }): Promise<DashboardSpace> {
  return dashboardRequest(`/api/tenants/${encodeURIComponent(input.tenantID)}/spaces/${encodeURIComponent(input.spaceID)}/archive`, { method: "POST", body: {} });
}

export function restoreSpace(input: { tenantID: string; spaceID: string }): Promise<DashboardSpace> {
  return dashboardRequest(`/api/tenants/${encodeURIComponent(input.tenantID)}/spaces/${encodeURIComponent(input.spaceID)}/restore`, { method: "POST", body: {} });
}

export async function listEpisodes(input: { tenantID: string; spaceID?: string; cursor?: string; pageSize?: number }): Promise<DashboardEpisodePage> {
  if (input.spaceID) return listSpaceEpisodes({ ...input, spaceID: input.spaceID });

  return listTenantEpisodes(input);
}

export function getEpisode(input: { tenantID: string; spaceID: string; episodeID: string }): Promise<DashboardEpisode> {
  return dashboardRequest(`/api/tenants/${encodeURIComponent(input.tenantID)}/spaces/${encodeURIComponent(input.spaceID)}/episodes/${encodeURIComponent(input.episodeID)}`);
}

export async function createEpisode(input: { tenantID: string; spaceID: string; metadata?: unknown; started_at?: string }): Promise<DashboardEpisode> {
  const { tenantID, spaceID, ...body } = input;
  const fingerprint = JSON.stringify({ tenantID, spaceID, body });
  const request = mutationRequestKey("episode-create", fingerprint);
  const episode = await dashboardRequest<DashboardEpisode>(`/api/tenants/${encodeURIComponent(tenantID)}/spaces/${encodeURIComponent(spaceID)}/episodes`, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": request.key },
  });
  clearMutationRequestKey(request.storageKey);
  return episode;
}

export async function endEpisode(input: { tenantID: string; spaceID: string; episodeID: string }): Promise<unknown> {
  const fingerprint = episodeEndFingerprint(input);
  const request = mutationRequestKey("episode-end", fingerprint);
  const result = await dashboardRequest<unknown>(`/api/tenants/${encodeURIComponent(input.tenantID)}/spaces/${encodeURIComponent(input.spaceID)}/episodes/${encodeURIComponent(input.episodeID)}/end`, {
    method: "POST",
    body: {},
    headers: { "Idempotency-Key": request.key },
  });
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
  return dashboardRequest(`/api/tenants/${encodeURIComponent(tenantID)}/api-keys${paginationSearch(options)}`);
}

export async function createAPIKey(tenantID: string, input: { name: string; scopes: string[]; expires_at: string }, options: { idempotencyKey?: string; recentAuth?: string } = {}): Promise<APIKeySecretResult> {
  const requestKey = options.idempotencyKey ?? crypto.randomUUID().replaceAll("-", "");
  return dashboardRequest(`/api/tenants/${encodeURIComponent(tenantID)}/api-keys`, {
    method: "POST",
    body: input,
    headers: mutationSecurityHeaders(requestKey, options.recentAuth),
  });
}

export async function rotateAPIKey(tenantID: string, keyID: string, input: { expires_at?: string } = {}, options: { idempotencyKey?: string; recentAuth?: string } = {}): Promise<APIKeySecretResult> {
  const requestKey = options.idempotencyKey ?? crypto.randomUUID().replaceAll("-", "");
  return dashboardRequest(`/api/tenants/${encodeURIComponent(tenantID)}/api-keys/${encodeURIComponent(keyID)}/rotate`, {
    method: "POST",
    body: input,
    headers: mutationSecurityHeaders(requestKey, options.recentAuth),
  });
}

export function revokeAPIKey(tenantID: string, keyID: string, options: { recentAuth?: string } = {}): Promise<void> {
  return dashboardRequest(`/api/tenants/${encodeURIComponent(tenantID)}/api-keys/${encodeURIComponent(keyID)}`, {
    method: "DELETE",
    headers: mutationSecurityHeaders(undefined, options.recentAuth),
  });
}

export function createRecentAuthProof(input: { password: string; action: string; resource_id?: string }): Promise<{ proof: string; expires_at: string }> {
  return dashboardRequest("/api/me/recent-auth", { method: "POST", body: input });
}

export type RecentAuthGoogleStart = { authorization_url: string; state: string };
export type RecentAuthProof = { proof: string; expires_at: string };

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

function paginationSearch(options: { cursor?: string; pageSize?: number; archived?: boolean }): string {
  const query = new URLSearchParams();
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.pageSize) query.set("page_size", String(options.pageSize));
  if (options.archived !== undefined) query.set("archived", String(options.archived));
  const search = query.toString();
  return search ? `?${search}` : "";
}

async function listSpaceEpisodes(input: { tenantID: string; spaceID: string; cursor?: string; pageSize?: number }): Promise<DashboardEpisodePage> {
  return dashboardRequest(`/api/tenants/${encodeURIComponent(input.tenantID)}/spaces/${encodeURIComponent(input.spaceID)}/episodes${paginationSearch(input)}`);
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
    throw new DashboardAPIError(400, "invalid_cursor", "Episode history cursor does not match this request");
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
    throw new DashboardAPIError(400, "invalid_cursor", "Episode history cursor is invalid");
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
      throw new DashboardAPIError(413, "episode_history_too_large", `Tenant-wide Episode history supports up to ${TENANT_EPISODE_MAX_SPACES} Spaces.`);
    }
    if (!page.pagination.has_more) return spaces;
    const nextCursor = page.pagination.next_cursor;
    if (!nextCursor || nextCursor === cursor) throw new DashboardAPIError(502, "invalid_pagination", "The Spaces history cursor was invalid.");
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
  throw new DashboardAPIError(400, "invalid_cursor", "Episode history cursor is invalid");
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

function mutationSecurityHeaders(idempotencyKey?: string, recentAuth?: string): HeadersInit {
  const headers = new Headers();
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (recentAuth) headers.set("X-Chalk-Recent-Auth", recentAuth);
  return headers;
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
