// The Cloudflare edge collector. Each scheduled run reads one five-minute HTTP
// analytics bucket per EDGE_HOSTS host from the Cloudflare GraphQL API and posts
// edge.http_rollup rows plus one edge.collector_tick per host. A bucket only
// counts where its ok tick exists, and a failed read is an error tick, never a
// zero.
//
// Raw request paths stay inside the query result: rows carry the path class.
// Zone ids are resolved at run time from the zone names the hosts fall under
// and are never stored in configuration or emitted.
export interface EdgeEnv {
  API_BASE_URL?: string;
  CF_GRAPHQL_TOKEN?: string;
  CHALK_AXIOM_INGEST_TOKEN?: string;
  CHALK_INFRA_DATASET?: string;
  CHALK_REQUESTS_DATASET?: string;
  EDGE_HOSTS?: string;
  EDGE_ENV?: string;
}

export const SCHEMA_VER = "66bca601fc49";
const BUCKET_MS = 5 * 60 * 1000;
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

interface EnvSecrets {
  token: string;
  infraDataset: string;
  requestsDataset: string;
  axiomToken: string;
}

function secrets(env: EdgeEnv): EnvSecrets | string {
  const missing: string[] = [];
  if (!env.CF_GRAPHQL_TOKEN) missing.push("CF_GRAPHQL_TOKEN");
  if (!env.CHALK_AXIOM_INGEST_TOKEN) missing.push("CHALK_AXIOM_INGEST_TOKEN");
  if (!env.CHALK_INFRA_DATASET) missing.push("CHALK_INFRA_DATASET");
  if (!env.CHALK_REQUESTS_DATASET) missing.push("CHALK_REQUESTS_DATASET");
  return missing.length
    ? `missing ${missing.join(", ")}`
    : { token: env.CF_GRAPHQL_TOKEN!, infraDataset: env.CHALK_INFRA_DATASET!, requestsDataset: env.CHALK_REQUESTS_DATASET!, axiomToken: env.CHALK_AXIOM_INGEST_TOKEN! };
}

export function deriveEnv(env: EdgeEnv): string {
  if (env.EDGE_ENV) return env.EDGE_ENV;
  const base = env.API_BASE_URL ?? "";
  try {
    return new URL(base).hostname.startsWith("nightly") ? "nightly" : "production";
  } catch {
    return "production";
  }
}

interface GraphQLResponse {
  data?: unknown;
  errors?: { message: string }[];
}

async function graphql(token: string, query: string, variables: Record<string, string>): Promise<GraphQLResponse> {
  const response = await fetch(GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`graphql_http_${response.status}`);
  return (await response.json()) as GraphQLResponse;
}

// Path classification keeps only the classes the rules read; everything else
// is "other". The health class never counts as Participant traffic.
export function pathClass(path: string): string {
  const clean = path.split("?")[0];
  if (clean === "/healthz" || clean === "/readyz" || clean.startsWith("/healthz/")) return "health";
  if (clean.startsWith("/assets/") || clean === "/favicon.ico" || clean === "/manifest.webmanifest") return "asset";
  if (clean.startsWith("/space/") || /^\/[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(clean)) return "space_page";
  return "other";
}

interface ZoneRow {
  zoneTag: string;
  name: string;
}

interface GroupRow {
  count: number;
  sum: { requests: number };
  dimensions: {
    clientRequestHTTPHost?: string;
    clientRequestPath?: string;
    edgeResponseStatus?: number;
    originResponseStatus?: number;
    clientRequestHTTPMethodName?: string;
    edgeResponseContentTypeName?: string;
    userAgentBot?: number;
  };
}

let seq = 0;

export function kernelRow(env: string, name: string, attrs: Record<string, unknown>, estServerMs: number, durationMs = 0): Record<string, unknown> {
  seq += 1;
  return {
    event_id: crypto.randomUUID(),
    kind: "fact",
    name,
    module: "checker",
    env,
    source_id: "edge-collector",
    seq,
    schema_ver: SCHEMA_VER,
    est_server_ms: estServerMs,
    ...(durationMs ? { duration_ms: durationMs } : {}),
    ...attrs,
  };
}

async function postRows(dataset: string, rows: Record<string, unknown>[], token: string): Promise<void> {
  if (rows.length === 0) return;
  const response = await fetch(`https://api.axiom.co/v1/datasets/${encodeURIComponent(dataset)}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error(`axiom_ingest_${response.status}`);
}

// listZones resolves the zone tag each EDGE_HOSTS host falls under. The lookup
// doubles as the collector's capability probe: if the token cannot read zones
// the run stops here instead of emitting untested filters.
async function listZones(token: string, hosts: string[]): Promise<Map<string, string>> {
  const response = await graphql(token, `{ viewer { zones { zoneTag name } } }`, {});
  if (response.errors?.length) throw new Error(`graphql_zones`);
  const zones = ((response.data as { viewer?: { zones?: ZoneRow[] } })?.viewer?.zones ?? []) as ZoneRow[];
  const mapping = new Map<string, string>();
  for (const host of hosts) {
    const zone = zones.find((z) => host === z.name || host.endsWith(`.${z.name}`));
    if (!zone) throw new Error(`no_zone_for_host`);
    mapping.set(host, zone.zoneTag);
  }
  return mapping;
}

const GROUPS_QUERY = `query EdgeRollup($zone: String!, $host: String!, $from: Time!, $to: Time!) {
  viewer {
    zones(filter: { zoneTag: $zone }) {
      httpRequestsAdaptiveGroups(
        limit: 10000
        filter: { datetime_geq: $from, datetime_lt: $to, clientRequestHTTPHost: $host }
      ) {
        count
        sum { requests }
        dimensions {
          clientRequestHTTPHost
          clientRequestPath
          edgeResponseStatus
          originResponseStatus
          clientRequestHTTPMethodName
          edgeResponseContentTypeName
          userAgentBot
        }
      }
    }
  }
}`;

interface RollupKey {
  path_class: string;
  edge_status: number;
  origin_status: number;
  method: string;
  content_class: string;
  ua_class: string;
}

// collectEdge reads the bucket [t-10m, t-5m) for the floored scheduled time t:
// the previous whole bucket, late enough for the analytics API to be complete.
export async function collectEdge(env: EdgeEnv, scheduledTime: number): Promise<{ buckets: number; ticks: number }> {
  if (!env.EDGE_HOSTS) return { buckets: 0, ticks: 0 };
  const hosts = env.EDGE_HOSTS.split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) return { buckets: 0, ticks: 0 };
  const configured = secrets(env);
  const envName = deriveEnv(env);
  const bucketStart = Math.floor(scheduledTime / BUCKET_MS) * BUCKET_MS - 2 * BUCKET_MS;
  const from = new Date(bucketStart).toISOString();
  const to = new Date(bucketStart + BUCKET_MS).toISOString();

  const tick = (host: string, status: string) =>
    kernelRow(envName, "edge.collector_tick", { bucket_start_ms: bucketStart, host, tick_status: status }, Date.now());

  if (typeof configured === "string") {
    const rows = hosts.map((host) => tick(host, `error(config)`));
    console.error(`edge collector not configured: ${configured}`);
    if (env.CHALK_AXIOM_INGEST_TOKEN && env.CHALK_INFRA_DATASET) {
      await postRows(env.CHALK_INFRA_DATASET, rows, env.CHALK_AXIOM_INGEST_TOKEN).catch(() => {});
    }
    return { buckets: 0, ticks: hosts.length };
  }

  let zoneByHost: Map<string, string>;
  try {
    zoneByHost = await listZones(configured.token, hosts);
  } catch (error) {
    const rows = hosts.map((host) => tick(host, `error(${error instanceof Error ? error.message : "zones"})`));
    await postRows(configured.infraDataset, rows, configured.axiomToken);
    return { buckets: 0, ticks: hosts.length };
  }

  const rollupRows: Record<string, unknown>[] = [];
  const tickRows: Record<string, unknown>[] = [];
  for (const host of hosts) {
    try {
      const response = await graphql(configured.token, GROUPS_QUERY, { zone: zoneByHost.get(host)!, host, from, to });
      if (response.errors?.length) throw new Error(`graphql_groups`);
      const groups = (((response.data as { viewer?: { zones?: { httpRequestsAdaptiveGroups?: GroupRow[] }[] } })?.viewer?.zones ?? [])[0]?.httpRequestsAdaptiveGroups ?? []) as GroupRow[];
      const totals = new Map<string, { key: RollupKey; requests: number }>();
      for (const group of groups) {
        const dimensions = group.dimensions;
        const key: RollupKey = {
          path_class: pathClass(dimensions.clientRequestPath ?? ""),
          edge_status: dimensions.edgeResponseStatus ?? 0,
          origin_status: dimensions.originResponseStatus ?? 0,
          method: (dimensions.clientRequestHTTPMethodName ?? "GET").toUpperCase(),
          content_class: (dimensions.edgeResponseContentTypeName ?? "").toLowerCase().includes("html") ? "html" : "other",
          ua_class: dimensions.userAgentBot === 1 ? "bot" : "browser",
        };
        const mapKey = JSON.stringify(key);
        const entry = totals.get(mapKey) ?? { key, requests: 0 };
        entry.requests += group.sum.requests;
        totals.set(mapKey, entry);
      }
      for (const { key, requests } of totals.values()) {
        rollupRows.push(
          kernelRow(envName, "edge.http_rollup", { bucket_start_ms: bucketStart, host, requests, ...key }, bucketStart, BUCKET_MS),
        );
      }
      tickRows.push(tick(host, "ok"));
    } catch (error) {
      tickRows.push(tick(host, `error(${error instanceof Error ? error.message : "groups"})`));
    }
  }
  await postRows(configured.requestsDataset, rollupRows, configured.axiomToken);
  await postRows(configured.infraDataset, tickRows, configured.axiomToken);
  return { buckets: rollupRows.length, ticks: tickRows.length };
}
