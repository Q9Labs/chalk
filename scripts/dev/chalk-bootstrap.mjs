import { FailureKind, failure } from "./model.mjs";
import { runChecked } from "./chalk-resources.mjs";

export async function bootstrapLocalSpace({ apiOrigin, systemToken, runtimeId, fixtureMarker, fetchImpl = fetch, fresh = false } = {}) {
  if (!apiOrigin || !systemToken || !runtimeId) throw failure(FailureKind.CONFIG, "API bootstrap requires origin, system token, and runtime id", { stage: "bootstrap" });
  const marker = fixtureMarker || runtimeMarker(runtimeId);
  const tenantName = `Chalk local dev ${marker}`;
  const tenantList = await request(fetchImpl, apiOrigin, "/v1/tenants?page_size=100", { systemToken });
  let tenant = tenantList.tenants?.find((entry) => entry.name === tenantName);
  if (!tenant) {
    tenant = await request(fetchImpl, apiOrigin, "/v1/tenants", {
      systemToken,
      method: "POST",
      body: {
        name: tenantName,
        default_region: "us",
        default_media_plane: "cf_sfu",
        media_plane_provider_config: { enabled: true, provider: "cf_sfu", mode: "chalk_managed" },
      },
    });
  }
  const spaceSlug = `chalk-local-${marker}`;
  const spacesResponse = await request(fetchImpl, apiOrigin, spacesPath(tenant.id, "?page_size=100"), { systemToken });
  let space = listSpaces(spacesResponse).find((entry) => entry.slug === spaceSlug);
  if (!space) {
    space = await request(fetchImpl, apiOrigin, spacesPath(tenant.id), {
      systemToken,
      method: "POST",
      headers: { "Idempotency-Key": `chalk-local-space-${marker}` },
      body: { name: `Chalk local Space ${marker}`, slug: spaceSlug, media_plane: "cf_sfu" },
    });
  }
  return {
    tenantId: tenant.id,
    spaceId: space.id,
    fresh,
    marker,
  };
}

export async function retireLocalFixture({ apiOrigin, systemToken, marker, runtimeId, fetchImpl = fetch } = {}) {
  if (!apiOrigin || !systemToken || !marker || !runtimeId) throw failure(FailureKind.CONFIG, "local fixture retirement requires origin, token, marker, and runtime id", { stage: "bootstrap" });
  const tenantName = `Chalk local dev ${marker}`;
  const tenantList = await request(fetchImpl, apiOrigin, "/v1/tenants?page_size=100", { systemToken });
  const tenant = tenantList.tenants?.find((entry) => entry.name === tenantName);
  if (!tenant) return { retired: false, marker };
  const spaceSlug = `chalk-local-${marker}`;
  const spacesResponse = await request(fetchImpl, apiOrigin, spacesPath(tenant.id, "?page_size=100"), { systemToken });
  const space = listSpaces(spacesResponse).find((entry) => entry.slug === spaceSlug);
  if (space) {
    await request(fetchImpl, apiOrigin, spacePath(tenant.id, space.id), {
      systemToken,
      method: "PATCH",
      body: { slug: `${spaceSlug}-retired-${runtimeId.slice(0, 8)}` },
    });
  }
  const deletedTenant = await request(fetchImpl, apiOrigin, `/v1/tenants/${tenant.id}`, {
    systemToken,
    method: "DELETE",
    ignoreStatuses: [404, 405],
  });
  if (deletedTenant === undefined)
    await request(fetchImpl, apiOrigin, `/v1/tenants/${tenant.id}`, {
      systemToken,
      method: "PATCH",
      body: { name: `${tenantName} retired ${runtimeId.slice(0, 8)}` },
    });
  return { retired: true, marker, tenantId: tenant.id, spaceId: space?.id };
}

export async function runSfuProbe({ root, appId, appSecret, runner = runChecked } = {}) {
  if (!appId || !appSecret) throw failure(FailureKind.CONFIG, "Cloudflare SFU credentials are missing", { stage: "provider" });
  const result = await runner("go", ["run", "./cmd/dev-sfu-probe"], {
    cwd: `${root}/apps/api`,
    env: {
      CHALK_CLOUDFLARE_REALTIME_APP_ID: appId,
      CHALK_CLOUDFLARE_REALTIME_APP_SECRET: appSecret,
    },
  });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw failure(FailureKind.STARTUP, "Cloudflare SFU probe returned invalid output", { stage: "provider", cause: error });
  }
  if (parsed.status !== "ok" || parsed.verified !== true) throw failure(FailureKind.STARTUP, "Cloudflare SFU probe did not verify a real connection", { stage: "provider" });
  return { status: "ok", verified: true };
}

function runtimeMarker(runtimeId) {
  return runtimeId
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 18)
    .toLowerCase();
}

function spacesPath(tenantId, suffix = "") {
  return `/v1/tenants/${tenantId}/spaces${suffix}`;
}

function spacePath(tenantId, spaceId) {
  return spacesPath(tenantId, `/${spaceId}`);
}

function listSpaces(response) {
  return response.spaces || [];
}

async function request(fetchImpl, origin, path, { systemToken, method = "GET", headers = {}, body, ignoreStatuses = [] } = {}) {
  const response = await fetchImpl(new URL(path, origin), {
    method,
    headers: { Authorization: `Bearer ${systemToken}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let decoded;
  try {
    decoded = text ? JSON.parse(text) : {};
  } catch {
    decoded = {};
  }
  if (!response.ok) {
    if (ignoreStatuses.includes(response.status)) return undefined;
    throw failure(FailureKind.STARTUP, `API bootstrap ${method} ${path} failed with HTTP ${response.status}`, { stage: "bootstrap" });
  }
  return decoded;
}
