// fallow-ignore-file unused-file
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readBoundedNodeBody } from "./node-request-body";
import type { DashboardEpisode } from "../src/lib/dashboard-api";

const host = "127.0.0.1";
const configuredPort = Number(process.env.CHALK_DASHBOARD_FIXTURE_API_PORT ?? "18080");
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536 ? configuredPort : 18080;
const accountToken = "local-dashboard-fixture-token";
const accountID = "10000000-0000-4000-8000-000000000001";
const tenantID = "20000000-0000-4000-8000-000000000001";
const accessID = "30000000-0000-4000-8000-000000000001";
const seededSpaceIDs = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002", "40000000-0000-4000-8000-000000000003"] as const;
const seededEpisodeIDs = ["50000000-0000-4000-8000-000000000001", "50000000-0000-4000-8000-000000000002", "50000000-0000-4000-8000-000000000003"] as const;
const seededAPIKeyID = "60000000-0000-4000-8000-000000000001";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyPattern = /^[A-Za-z0-9_-]{16,128}$/;
const actionPattern = /^[a-z][a-z0-9._:-]{0,63}$/;

type JSONRecord = Record<string, unknown>;

type DashboardAccount = {
  id: string;
  name: string;
  email: string;
  updated_at: string;
  created_at: string;
};

type Tenant = {
  id: string;
  name: string;
  default_region: string | null;
  default_media_plane: string | null;
  media_plane_provider_config: unknown;
  ai_provider_config: unknown;
  storage_provider_config: unknown;
  logo_key: string | null;
  website: string | null;
  updated_at: string;
  created_at: string;
};

type TenantAccess = {
  id: string;
  tenant_id: string;
  account_id: string;
  role: string;
  updated_at: string;
  created_at: string;
};

type AccountTenant = { tenant: Tenant; access: TenantAccess };

type SpaceRole = { id: string; name: string; capabilities: string[] };

type Space = {
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
  archived_at: string | null;
  archived: boolean;
  roles: SpaceRole[];
  created_by_user_id: string | null;
  updated_at: string;
  created_at: string;
};

type Episode = DashboardEpisode & { end_reason: string | null; ended_at: string | null };

type APIKey = {
  id: string;
  tenant_id: string;
  name: string;
  scopes: string[];
  key_prefix: string;
  secret: string;
  created_by_user_id: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string;
  updated_at: string;
  created_at: string;
};

type IdempotencyRecord = { fingerprint: string; status: number; response: unknown };
type RecentAuthRecord = { account_id: string; action: string; resource_id: string | null; expires_at: number };

const account: DashboardAccount = {
  id: accountID,
  name: "Hasan Shoaib",
  email: "hasan@example.com",
  updated_at: "2026-08-04T00:00:00.000Z",
  created_at: "2026-08-04T00:00:00.000Z",
};
let accountPassword = "password-1";
let accountTenants: AccountTenant[] = [];
const spaces = new Map<string, Space>();
const episodes = new Map<string, Episode>();
const apiKeys = new Map<string, APIKey>();
const onboardingIdempotency = new Map<string, IdempotencyRecord>();
const spaceIdempotency = new Map<string, IdempotencyRecord>();
const episodeIdempotency = new Map<string, IdempotencyRecord>();
const apiKeyIdempotency = new Map<string, IdempotencyRecord>();
const recentAuthProofs = new Map<string, RecentAuthRecord>();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "ok" });
    if (request.method === "POST" && ["/v1/auth/register", "/v1/auth/login"].includes(url.pathname)) return await handleAuthentication(request, response);
    if (!authenticated(request)) return sendError(response, 401, "unauthenticated", "Authentication required");
    if (request.method === "POST" && url.pathname === "/v1/auth/logout") return sendEmpty(response, 204);
    if (request.method === "GET" && url.pathname === "/v1/me") return send(response, 200, account);
    if (request.method === "GET" && url.pathname === "/v1/regions") return send(response, 200, regions);
    if (request.method === "GET" && url.pathname === "/v1/me/tenants") return handleListAccountTenants(url, response);
    if (request.method === "POST" && url.pathname === "/v1/me/tenants") return await handleOnboardTenant(request, response);
    if (request.method === "POST" && url.pathname === "/v1/me/recent-auth") return await handleRecentAuth(request, response);
    if (url.pathname.startsWith("/v1/tenants/")) return await handleTenantRoute(url, request, response);
    return sendError(response, 404, "not_found", "Fixture route not found");
  } catch (error) {
    if (error instanceof FixtureError) return sendError(response, error.status, error.code, error.message);
    return sendError(response, 500, "internal_error", "Fixture request failed");
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "dashboard_fixture.ready", origin: `http://${host}:${port}` }));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

const regions = {
  regions: [
    { code: "us", name: "United States" },
    { code: "eu", name: "Europe" },
    { code: "ap", name: "Asia Pacific" },
  ],
};

async function handleAuthentication(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJSON(request);
  const email = stringValue(body.email);
  const name = stringValue(body.name);
  const password = stringValue(body.password);
  if (email) account.email = email;
  if (name) account.name = name;
  if (password) accountPassword = password;
  account.updated_at = now();
  return send(response, 200, { user: account, session_token: accountToken, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
}

function handleListAccountTenants(url: URL, response: ServerResponse): void {
  const page = paginate(accountTenants, url);
  return send(response, 200, { tenants: page.items, pagination: page.pagination });
}

async function handleOnboardTenant(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJSON(request);
  const name = stringValue(body.name);
  const defaultRegion = stringValue(body.default_region) || "us";
  if (!name) throw new FixtureError(400, "invalid_request", "Tenant name is required");
  if (!regions.regions.some((region) => region.code === defaultRegion)) throw new FixtureError(400, "tenant.invalid_region", "Tenant region is not available");

  const requestKey = request.headers["idempotency-key"]?.toString().trim() ?? "";
  const fingerprint = JSON.stringify({ name, default_region: defaultRegion });
  if (requestKey) {
    validateIdempotencyKey(requestKey);
    const previous = onboardingIdempotency.get(requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw idempotencyConflict();
      return send(response, previous.status, { ...(previous.response as JSONRecord), replayed: true });
    }
  }
  if (accountTenants.length > 0) throw new FixtureError(409, "tenant.already_exists", "This fixture account already has a Tenant");

  const createdAt = now();
  const tenant: Tenant = {
    id: tenantID,
    name,
    default_region: defaultRegion,
    default_media_plane: "cf_rtk",
    media_plane_provider_config: null,
    ai_provider_config: null,
    storage_provider_config: null,
    logo_key: null,
    website: null,
    updated_at: createdAt,
    created_at: createdAt,
  };
  const access: TenantAccess = { id: accessID, tenant_id: tenantID, account_id: account.id, role: "owner", updated_at: createdAt, created_at: createdAt };
  const result = { tenant, access };
  accountTenants = [result];
  seedTenantFixtures(createdAt);
  const responseValue = { ...result, replayed: false };
  if (requestKey) onboardingIdempotency.set(requestKey, { fingerprint, status: 201, response: responseValue });
  return send(response, 201, responseValue);
}

async function handleRecentAuth(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJSON(request);
  const password = stringValue(body.password);
  const action = stringValue(body.action) ?? "";
  const resourceID = stringValue(body.resource_id) || null;
  if (!password || password !== accountPassword) throw new FixtureError(401, "auth.invalid_recent_auth", "Recent authentication could not be verified");
  if (!actionPattern.test(action)) throw new FixtureError(400, "invalid_request", "Recent-auth action is invalid");
  if (resourceID && !uuidPattern.test(resourceID)) throw new FixtureError(400, "invalid_request", "Recent-auth resource is invalid");
  const proof = `fixture-ra1-${randomUUID()}`;
  const expiresAt = Date.now() + 5 * 60 * 1000;
  recentAuthProofs.set(proof, { account_id: account.id, action, resource_id: resourceID, expires_at: expiresAt });
  return send(response, 200, { proof, expires_at: new Date(expiresAt).toISOString() });
}

function handleTenantRoute(url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> | void {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[0] !== "v1" || segments[1] !== "tenants") return sendError(response, 404, "not_found", "Fixture route not found");
  const requestedTenantID = segments[2] ?? "";
  if (!uuidPattern.test(requestedTenantID)) throw new FixtureError(400, "tenant.invalid_id", "Invalid Tenant id");
  if (!accountTenants.some((entry) => entry.tenant.id === requestedTenantID)) throw new FixtureError(404, "tenant.not_found", "Tenant not found");
  if (segments[3] === "spaces") return handleSpaceRoute(requestedTenantID, segments, url, request, response);
  if (segments[3] === "api-keys") return handleAPIKeyRoute(requestedTenantID, segments, url, request, response);
  return sendError(response, 404, "not_found", "Fixture route not found");
}

function handleSpaceRoute(requestedTenantID: string, segments: string[], url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> | void {
  if (segments.length === 4) {
    if (request.method === "GET") return handleListSpaces(requestedTenantID, url, response);
    if (request.method === "POST") return handleCreateSpace(requestedTenantID, request, response);
    return sendError(response, 404, "not_found", "Fixture route not found");
  }
  const spaceID = segments[4] ?? "";
  if (!uuidPattern.test(spaceID)) throw new FixtureError(400, "space.invalid_id", "Invalid Space id");
  const space = spaces.get(spaceID);
  if (!space || space.tenant_id !== requestedTenantID) throw new FixtureError(404, "space.not_found", "Space not found");
  if (segments.length === 5) {
    if (request.method === "GET") return send(response, 200, space);
    if (request.method === "PATCH") return handleUpdateSpace(space, request, response);
    return sendError(response, 404, "not_found", "Fixture route not found");
  }
  if (segments[5] === "archive" && segments.length === 6 && request.method === "POST") return handleArchiveSpace(space, response, true);
  if (segments[5] === "restore" && segments.length === 6 && request.method === "POST") return handleArchiveSpace(space, response, false);
  if (segments[5] !== "episodes") return sendError(response, 404, "not_found", "Fixture route not found");
  if (segments.length === 6) {
    if (request.method === "GET") return handleListEpisodes(requestedTenantID, spaceID, url, response);
    if (request.method === "POST") return handleCreateEpisode(requestedTenantID, space, request, response);
    return sendError(response, 404, "not_found", "Fixture route not found");
  }
  const episodeID = segments[6] ?? "";
  if (!uuidPattern.test(episodeID)) throw new FixtureError(400, "episode.invalid_id", "Invalid Episode id");
  const episode = episodes.get(episodeID);
  if (!episode || episode.tenant_id !== requestedTenantID || episode.space_id !== spaceID) throw new FixtureError(404, "episode.not_found", "Episode not found");
  if (segments.length === 7 && request.method === "GET") return send(response, 200, episode);
  if (segments.length === 8 && segments[7] === "end" && request.method === "POST") return handleEndEpisode(episode, request, response);
  return sendError(response, 404, "not_found", "Fixture route not found");
}

async function handleListSpaces(requestedTenantID: string, url: URL, response: ServerResponse): Promise<void> {
  const archived = url.searchParams.get("archived");
  if (archived !== null && archived !== "true" && archived !== "false") throw new FixtureError(400, "space.invalid_archive_filter", "Invalid archived filter");
  const values = Array.from(spaces.values()).filter((space) => space.tenant_id === requestedTenantID && (archived === null || (archived === "true" ? space.archived : !space.archived)));
  const page = paginate(values, url);
  return send(response, 200, { spaces: page.items, pagination: page.pagination });
}

async function handleCreateSpace(requestedTenantID: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestKey = request.headers["idempotency-key"]?.toString().trim() ?? "";
  validateIdempotencyKey(requestKey);
  const body = await readJSON(request);
  const name = requiredString(body.name, "Space name");
  const slug = requiredString(body.slug, "Space slug");
  const fingerprint = JSON.stringify({ tenant_id: requestedTenantID, body });
  const idempotencyKey = `space:create:${requestedTenantID}:${requestKey}`;
  const previous = spaceIdempotency.get(idempotencyKey);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw idempotencyConflict();
    return send(response, previous.status, previous.response);
  }
  if (Array.from(spaces.values()).some((space) => space.tenant_id === requestedTenantID && space.slug === slug)) throw new FixtureError(409, "space.slug_conflict", "Space slug is already used");
  const createdAt = now();
  const defaultDuration = integerValue(body.default_episode_duration_seconds, 86_400);
  const maximumDuration = integerValue(body.maximum_episode_duration_seconds, defaultDuration);
  if (defaultDuration < 60 || maximumDuration < defaultDuration) throw new FixtureError(400, "invalid_request", "Space episode duration is invalid");
  const space = makeSpace({ id: randomUUID(), tenantID: requestedTenantID, name, slug, createdAt, body, defaultDuration, maximumDuration });
  spaces.set(space.id, space);
  spaceIdempotency.set(idempotencyKey, { fingerprint, status: 201, response: space });
  return send(response, 201, space);
}

async function handleUpdateSpace(space: Space, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJSON(request);
  const nextSlug = body.slug === undefined ? space.slug : requiredString(body.slug, "Space slug");
  if (nextSlug !== space.slug && Array.from(spaces.values()).some((other) => other.id !== space.id && other.tenant_id === space.tenant_id && other.slug === nextSlug)) throw new FixtureError(409, "space.slug_conflict", "Space slug is already used");
  const nextDefault = body.default_episode_duration_seconds === undefined ? space.default_episode_duration_seconds : integerValue(body.default_episode_duration_seconds, space.default_episode_duration_seconds);
  const nextMaximum = body.maximum_episode_duration_seconds === undefined ? space.maximum_episode_duration_seconds : integerValue(body.maximum_episode_duration_seconds, space.maximum_episode_duration_seconds);
  if (nextDefault < 60 || nextMaximum < nextDefault) throw new FixtureError(400, "invalid_request", "Space episode duration is invalid");
  if (body.name !== undefined) space.name = requiredString(body.name, "Space name");
  if (body.slug !== undefined) space.slug = nextSlug;
  if (body.media_plane !== undefined) space.media_plane = requiredString(body.media_plane, "Media plane");
  if (body.metadata !== undefined) space.metadata = body.metadata;
  if (body.recurring_policy !== undefined) space.recurring_policy = body.recurring_policy;
  if (body.admission_policy !== undefined) space.admission_policy = body.admission_policy;
  if (body.default_episode_duration_seconds !== undefined) space.default_episode_duration_seconds = nextDefault;
  if (body.maximum_episode_duration_seconds !== undefined) space.maximum_episode_duration_seconds = nextMaximum;
  if (body.linger_window_seconds !== undefined) space.linger_window_seconds = integerValue(body.linger_window_seconds, space.linger_window_seconds);
  space.updated_at = now();
  return send(response, 200, space);
}

function handleArchiveSpace(space: Space, response: ServerResponse, archived: boolean): void {
  space.archived = archived;
  space.archived_at = archived ? now() : null;
  space.updated_at = now();
  return send(response, 200, space);
}

async function handleListEpisodes(requestedTenantID: string, spaceID: string, url: URL, response: ServerResponse): Promise<void> {
  const values = Array.from(episodes.values())
    .filter((episode) => episode.tenant_id === requestedTenantID && episode.space_id === spaceID)
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at));
  const page = paginate(values, url);
  return send(response, 200, { episodes: page.items, pagination: page.pagination });
}

async function handleCreateEpisode(requestedTenantID: string, space: Space, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestKey = request.headers["idempotency-key"]?.toString().trim() ?? "";
  validateIdempotencyKey(requestKey);
  const body = await readJSON(request);
  const fingerprint = JSON.stringify({ tenant_id: requestedTenantID, space_id: space.id, body });
  const idempotencyKey = `episode:create:${requestedTenantID}:${space.id}:${requestKey}`;
  const previous = episodeIdempotency.get(idempotencyKey);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw idempotencyConflict();
    return send(response, previous.status, previous.response);
  }
  if (Array.from(episodes.values()).some((episode) => episode.space_id === space.id && (episode.status === "active" || episode.status === "ending"))) throw new FixtureError(409, "episode.capacity_exceeded", "Space already has a live Episode");
  const createdAt = now();
  const startedAt = parseTimestamp(body.started_at) ?? createdAt;
  const episode: Episode = {
    id: randomUUID(),
    tenant_id: requestedTenantID,
    space_id: space.id,
    status: "active",
    metadata: body.metadata ?? null,
    config_snapshot: episodeConfigSnapshot(space),
    end_reason: null,
    started_at: startedAt,
    ended_at: null,
    deadline_at: new Date(Date.parse(startedAt) + space.maximum_episode_duration_seconds * 1000).toISOString(),
    deadline_generation: 1,
    updated_at: createdAt,
    created_at: createdAt,
  };
  episodes.set(episode.id, episode);
  episodeIdempotency.set(idempotencyKey, { fingerprint, status: 201, response: episode });
  return send(response, 201, episode);
}

function handleEndEpisode(episode: Episode, request: IncomingMessage, response: ServerResponse): void {
  const requestKey = request.headers["idempotency-key"]?.toString().trim() ?? "";
  validateIdempotencyKey(requestKey);
  const idempotencyKey = `episode:end:${episode.tenant_id}:${episode.space_id}:${episode.id}:${requestKey}`;
  const previous = episodeIdempotency.get(idempotencyKey);
  if (previous) return send(response, previous.status, previous.response);
  if (episode.status !== "active") throw new FixtureError(409, "episode.not_active", "Episode is not active");
  const createdAt = now();
  episode.status = "ended";
  episode.ended_at = createdAt;
  episode.end_reason = "requested";
  episode.updated_at = createdAt;
  const result = {
    episode_id: episode.id,
    status: episode.status,
    external_operation: {
      id: randomUUID(),
      request_key: requestKey,
      operation_name: "tenant_end_episode",
      status: "completed",
      created_at: createdAt,
    },
  };
  episodeIdempotency.set(idempotencyKey, { fingerprint: requestKey, status: 202, response: result });
  return send(response, 202, result);
}

function handleAPIKeyRoute(requestedTenantID: string, segments: string[], url: URL, request: IncomingMessage, response: ServerResponse): Promise<void> | void {
  if (segments.length === 4) {
    if (request.method === "GET") return handleListAPIKeys(requestedTenantID, url, response);
    if (request.method === "POST") return handleCreateAPIKey(requestedTenantID, request, response);
    return sendError(response, 404, "not_found", "Fixture route not found");
  }
  const keyID = segments[4] ?? "";
  if (!uuidPattern.test(keyID)) throw new FixtureError(400, "api_key.invalid_id", "Invalid API key id");
  const key = apiKeys.get(keyID);
  if (!key || key.tenant_id !== requestedTenantID) throw new FixtureError(404, "api_key.not_found", "API key not found");
  if (segments.length === 5 && request.method === "DELETE") return handleRevokeAPIKey(key, request, response);
  if (segments.length === 6 && segments[5] === "rotate" && request.method === "POST") return handleRotateAPIKey(key, request, response);
  return sendError(response, 404, "not_found", "Fixture route not found");
}

async function handleListAPIKeys(requestedTenantID: string, url: URL, response: ServerResponse): Promise<void> {
  const values = Array.from(apiKeys.values())
    .filter((key) => key.tenant_id === requestedTenantID)
    .map(publicAPIKey);
  const page = paginate(values, url);
  return send(response, 200, { api_keys: page.items, pagination: page.pagination });
}

async function handleCreateAPIKey(requestedTenantID: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  requireRecentAuth(request, "api_key.create", requestedTenantID);
  const body = await readJSON(request);
  const name = requiredString(body.name, "API key name");
  const scopes = stringArray(body.scopes);
  const expiresAt = requiredTimestamp(body.expires_at, "API key expiry");
  const requestKey = request.headers["idempotency-key"]?.toString().trim() ?? "";
  if (requestKey) {
    validateIdempotencyKey(requestKey);
    const idempotencyKey = `api-key:create:${requestedTenantID}:${requestKey}`;
    if (apiKeyIdempotency.has(idempotencyKey)) throw apiKeySecretNotReplayable();
    const key = makeAPIKey({ id: randomUUID(), tenantID: requestedTenantID, name, scopes, expiresAt });
    apiKeys.set(key.id, key);
    const result = { api_key: publicAPIKey(key), secret: key.secret };
    apiKeyIdempotency.set(idempotencyKey, { fingerprint: JSON.stringify({ requestedTenantID, body }), status: 201, response: { api_key: publicAPIKey(key) } });
    return send(response, 201, result);
  }
  const key = makeAPIKey({ id: randomUUID(), tenantID: requestedTenantID, name, scopes, expiresAt });
  apiKeys.set(key.id, key);
  return send(response, 201, { api_key: publicAPIKey(key), secret: key.secret });
}

async function handleRotateAPIKey(key: APIKey, request: IncomingMessage, response: ServerResponse): Promise<void> {
  requireRecentAuth(request, "api_key.rotate", key.id);
  if (key.revoked_at || Date.parse(key.expires_at) <= Date.now()) throw new FixtureError(409, "api_key.inactive", "API key is not active");
  const body = await readJSON(request);
  const requestKey = request.headers["idempotency-key"]?.toString().trim() ?? "";
  if (requestKey) {
    validateIdempotencyKey(requestKey);
    const idempotencyKey = `api-key:rotate:${key.tenant_id}:${key.id}:${requestKey}`;
    if (apiKeyIdempotency.has(idempotencyKey)) throw apiKeySecretNotReplayable();
    if (body.expires_at !== undefined && body.expires_at !== null) key.expires_at = requiredTimestamp(body.expires_at, "API key expiry");
    key.secret = `ch_fixture_${randomUUID().replaceAll("-", "")}`;
    key.key_prefix = `${key.secret.slice(0, 18)}…`;
    key.updated_at = now();
    const result = { api_key: publicAPIKey(key), secret: key.secret };
    apiKeyIdempotency.set(idempotencyKey, { fingerprint: JSON.stringify({ keyID: key.id, body }), status: 200, response: { api_key: publicAPIKey(key) } });
    return send(response, 200, result);
  }
  if (body.expires_at !== undefined && body.expires_at !== null) key.expires_at = requiredTimestamp(body.expires_at, "API key expiry");
  key.secret = `ch_fixture_${randomUUID().replaceAll("-", "")}`;
  key.key_prefix = `${key.secret.slice(0, 18)}…`;
  key.updated_at = now();
  return send(response, 200, { api_key: publicAPIKey(key), secret: key.secret });
}

function handleRevokeAPIKey(key: APIKey, request: IncomingMessage, response: ServerResponse): void {
  requireRecentAuth(request, "api_key.revoke", key.id);
  if (key.revoked_at || Date.parse(key.expires_at) <= Date.now()) throw new FixtureError(409, "api_key.inactive", "API key is not active");
  key.revoked_at = now();
  key.updated_at = key.revoked_at;
  return sendEmpty(response, 204);
}

function requireRecentAuth(request: IncomingMessage, action: string, resourceID: string): void {
  const proof = request.headers["x-chalk-recent-auth"]?.toString().trim() ?? "";
  if (!proof) throw new FixtureError(428, "access.recent_auth_required", "Recent authentication is required for this API key action");
  const record = recentAuthProofs.get(proof);
  if (!record || record.expires_at <= Date.now() || record.account_id !== account.id || record.action !== action || record.resource_id !== resourceID) throw new FixtureError(403, "access.recent_auth_invalid", "Recent authentication could not be verified");
}

function publicAPIKey(key: APIKey): Omit<APIKey, "secret"> {
  const { secret: _secret, ...safe } = key;
  return safe;
}

function seedTenantFixtures(createdAt: string): void {
  spaces.clear();
  episodes.clear();
  apiKeys.clear();
  const firstCreated = "2026-08-04T00:00:00.000Z";
  const product = makeSpace({
    id: seededSpaceIDs[0],
    tenantID,
    name: "Product studio",
    slug: "product-studio",
    createdAt: firstCreated,
    body: { metadata: { description: "Weekly critiques, focused work, and product decisions." }, default_episode_duration_seconds: 86_400, maximum_episode_duration_seconds: 86_400, linger_window_seconds: 0 },
    defaultDuration: 86_400,
    maximumDuration: 86_400,
  });
  const research = makeSpace({
    id: seededSpaceIDs[1],
    tenantID,
    name: "Research lab",
    slug: "research-lab",
    createdAt: "2026-08-03T00:00:00.000Z",
    body: { metadata: { description: "Customer conversations and synthesis with the research team." }, default_episode_duration_seconds: 86_400, maximum_episode_duration_seconds: 86_400, linger_window_seconds: 0 },
    defaultDuration: 86_400,
    maximumDuration: 86_400,
  });
  const campfire = makeSpace({
    id: seededSpaceIDs[2],
    tenantID,
    name: "Company campfire",
    slug: "company-campfire",
    createdAt: "2026-08-01T00:00:00.000Z",
    body: { metadata: { description: "A durable home for all-hands Episodes and shared context." }, default_episode_duration_seconds: 86_400, maximum_episode_duration_seconds: 86_400, linger_window_seconds: 0 },
    defaultDuration: 86_400,
    maximumDuration: 86_400,
  });
  spaces.set(product.id, product);
  spaces.set(research.id, research);
  spaces.set(campfire.id, campfire);
  const activeEpisode = makeEpisode(seededEpisodeIDs[0], campfire, "2026-08-04T00:00:00.000Z", "active", createdAt);
  const endedEpisode = makeEpisode(seededEpisodeIDs[1], research, "2026-08-03T00:00:00.000Z", "ended", "2026-08-03T00:58:00.000Z");
  endedEpisode.ended_at = "2026-08-03T00:58:00.000Z";
  endedEpisode.end_reason = "requested";
  const olderEpisode = makeEpisode(seededEpisodeIDs[2], product, "2026-07-28T00:00:00.000Z", "ended", "2026-07-28T00:35:00.000Z");
  olderEpisode.ended_at = "2026-07-28T00:35:00.000Z";
  olderEpisode.end_reason = "requested";
  episodes.set(activeEpisode.id, activeEpisode);
  episodes.set(endedEpisode.id, endedEpisode);
  episodes.set(olderEpisode.id, olderEpisode);
  apiKeys.set(seededAPIKeyID, makeAPIKey({ id: seededAPIKeyID, tenantID, name: "Local integration", scopes: ["spaces:read", "episodes:read"], expiresAt: "2027-08-04T00:00:00.000Z" }));
}

function makeSpace(input: { id: string; tenantID: string; name: string; slug: string; createdAt: string; body: JSONRecord; defaultDuration: number; maximumDuration: number }): Space {
  return {
    id: input.id,
    tenant_id: input.tenantID,
    name: input.name,
    slug: input.slug,
    media_plane: stringValue(input.body.media_plane) || "cf_rtk",
    metadata: input.body.metadata ?? null,
    recurring_policy: input.body.recurring_policy ?? null,
    admission_policy: input.body.admission_policy ?? null,
    default_episode_duration_seconds: input.defaultDuration,
    maximum_episode_duration_seconds: input.maximumDuration,
    linger_window_seconds: integerValue(input.body.linger_window_seconds, 0),
    archived_at: null,
    archived: false,
    roles: defaultRoles(),
    created_by_user_id: account.id,
    updated_at: input.createdAt,
    created_at: input.createdAt,
  };
}

function makeEpisode(id: string, space: Space, startedAt: string, status: Episode["status"], updatedAt: string): Episode {
  return {
    id,
    tenant_id: space.tenant_id,
    space_id: space.id,
    status,
    metadata: null,
    config_snapshot: episodeConfigSnapshot(space),
    end_reason: null,
    started_at: startedAt,
    ended_at: null,
    deadline_at: new Date(Date.parse(startedAt) + space.maximum_episode_duration_seconds * 1000).toISOString(),
    deadline_generation: 1,
    updated_at: updatedAt,
    created_at: startedAt,
  };
}

function makeAPIKey(input: { id: string; tenantID: string; name: string; scopes: string[]; expiresAt: string }): APIKey {
  const secret = `ch_fixture_${randomUUID().replaceAll("-", "")}`;
  const createdAt = now();
  return { id: input.id, tenant_id: input.tenantID, name: input.name, scopes: input.scopes, key_prefix: `${secret.slice(0, 18)}…`, secret, created_by_user_id: account.id, last_used_at: null, revoked_at: null, expires_at: input.expiresAt, updated_at: createdAt, created_at: createdAt };
}

function defaultRoles(): SpaceRole[] {
  return [
    { id: randomUUID(), name: "owner", capabilities: ["startEpisode", "endEpisode", "manageMembers", "manageRecording"] },
    { id: randomUUID(), name: "collaborator", capabilities: ["startEpisode", "sendChat", "publishAudio", "publishVideo"] },
    { id: randomUUID(), name: "observer", capabilities: ["subscribe"] },
  ];
}

function episodeConfigSnapshot(space: Space): JSONRecord {
  return {
    media_plane: space.media_plane,
    recurring_policy: space.recurring_policy,
    admission_policy: space.admission_policy,
    default_episode_duration_seconds: space.default_episode_duration_seconds,
    maximum_episode_duration_seconds: space.maximum_episode_duration_seconds,
    linger_window_seconds: space.linger_window_seconds,
  };
}

function paginate<T>(values: T[], url: URL): { items: T[]; pagination: { page_size: number; next_cursor: string | null; has_more: boolean } } {
  const pageSize = parsePageSize(url.searchParams.get("page_size"));
  const rawCursor = url.searchParams.get("cursor");
  const offset = rawCursor ? Number(rawCursor) : 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > values.length) throw new FixtureError(400, "pagination.invalid_cursor", "Invalid cursor");
  const items = values.slice(offset, offset + pageSize);
  const hasMore = offset + items.length < values.length;
  return { items, pagination: { page_size: pageSize, next_cursor: hasMore ? String(offset + items.length) : null, has_more: hasMore } };
}

function parsePageSize(value: string | null): number {
  if (value === null || value.trim() === "") return 25;
  const pageSize = Number(value);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new FixtureError(400, "pagination.invalid_page_size", "Invalid page size");
  return pageSize;
}

function validateIdempotencyKey(value: string): void {
  if (!idempotencyPattern.test(value)) throw new FixtureError(400, "request.invalid_idempotency_key", "Idempotency-Key is invalid");
}

function requiredString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result) throw new FixtureError(400, "invalid_request", `${field} is required`);
  return result;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new FixtureError(400, "invalid_request", "Scopes must be an array of strings");
  return value.map((item) => item.trim()).filter(Boolean);
}

function integerValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new FixtureError(400, "invalid_request", "Expected an integer");
  return value;
}

function requiredTimestamp(value: unknown, field: string): string {
  const parsed = parseTimestamp(value);
  if (!parsed) throw new FixtureError(400, "invalid_request", `${field} is invalid`);
  return parsed;
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function authenticated(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${accountToken}`;
}

async function readJSON(request: IncomingMessage): Promise<JSONRecord> {
  const body = await readBoundedNodeBody(request, 64 * 1024, "fixture body too large");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new FixtureError(400, "invalid_request", "Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FixtureError(400, "invalid_request", "Request body must be an object");
  return value as JSONRecord;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Pragma: "no-cache" });
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  return send(response, status, { error: { code, message } });
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Cache-Control": "no-store", Pragma: "no-cache" });
  response.end();
}

function idempotencyConflict(): FixtureError {
  return new FixtureError(409, "request.idempotency_conflict", "Idempotency key was already used for another request");
}

function apiKeySecretNotReplayable(): FixtureError {
  return new FixtureError(409, "api_key.secret_not_replayable", "An API key secret is only available from the first successful response");
}

function now(): string {
  return new Date().toISOString();
}

class FixtureError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
