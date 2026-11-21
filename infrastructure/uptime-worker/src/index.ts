import { runJoinProbe, type ProbeEnv } from "./probe.ts";
import { collectEdge, deriveEnv, kernelRow, type EdgeEnv } from "./edge.ts";

export interface Env extends ProbeEnv, EdgeEnv {
  API_BASE_URL?: string;
  API_MONITOR_BASE_URL?: string;
  SYNC_BASE_URL?: string;
  /** Same Discord webhook input used by the Axiom monitor provisioner. */
  DISCORD_WEBHOOK_URL?: string;
  OPS_MANUAL_RUN_TOKEN?: string;
}

type CheckResult = { readonly name: string; readonly healthy: boolean; readonly status?: number; readonly fetched: boolean; readonly durationMs: number };

function baseURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Monitor targets require HTTPS without credentials");
  return url;
}

async function check(name: string, url: URL): Promise<CheckResult> {
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Chalk-Uptime/1.0" } });
    await response.body?.cancel();
    return { name, healthy: response.status === 200, status: response.status, fetched: true, durationMs: Date.now() - started };
  } catch {
    return { name, healthy: false, fetched: false, durationMs: Date.now() - started };
  }
}

// postUptimeRows records each probe as an edge.uptime_check row: whether the
// target answered healthy, its HTTP status and the probe duration. A throw from
// fetch is unavailable(fetch_failed), never a zero status. Posting is the best
// effort of the monitor cycle; a missing row shows as a coverage gap.
async function postUptimeRows(env: Env, results: CheckResult[]): Promise<void> {
  if (!env.CHALK_AXIOM_INGEST_TOKEN || !env.CHALK_INFRA_DATASET) return;
  const envName = deriveEnv(env);
  const rows = results.map((result) =>
    kernelRow(
      envName,
      "edge.uptime_check",
      {
        target: result.name,
        uptime_status: !result.fetched ? "unavailable(fetch_failed)" : result.healthy ? "ok" : "failed",
        http_status: result.status ?? 0,
        origin_reach: result.healthy ? "up" : "down",
      },
      Date.now() - result.durationMs,
      result.durationMs,
    ),
  );
  const response = await fetch(`https://api.axiom.co/v1/datasets/${encodeURIComponent(env.CHALK_INFRA_DATASET)}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.CHALK_AXIOM_INGEST_TOKEN}` },
    body: JSON.stringify(rows),
  });
  await response.body?.cancel();
}

async function notify(webhook: URL, content: string): Promise<void> {
  const response = await fetch(webhook, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Discord alert delivery failed (HTTP ${response.status})`);
}

export async function runMonitorCycle(env: Env): Promise<{ readonly checked: number; readonly failed: number }> {
  if (!env.DISCORD_WEBHOOK_URL) throw new Error("DISCORD_WEBHOOK_URL must be set for this environment");
  const webhook = new URL(env.DISCORD_WEBHOOK_URL);
  if (webhook.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(webhook.hostname) || !webhook.pathname.startsWith("/api/webhooks/")) throw new Error("Invalid Discord webhook configuration");
  const apiTarget = env.API_MONITOR_BASE_URL ?? env.API_BASE_URL;
  if (!apiTarget || !env.SYNC_BASE_URL) throw new Error("API_BASE_URL and SYNC_BASE_URL must be set in this Worker's wrangler vars");
  const api = baseURL(apiTarget);
  const sync = baseURL(env.SYNC_BASE_URL);
  const results = await Promise.all([check("API health", new URL("/healthz", api)), check("API readiness", new URL("/readyz", api)), check("Sync health", new URL("/healthz", sync)), check("Sync readiness", new URL("/readyz", sync))]);
  await postUptimeRows(env, results).catch(() => {});
  const failures = results.filter((result) => !result.healthy);
  if (failures.length > 0) {
    await notify(
      webhook,
      `Chalk uptime check failed\n${failures.map((failure) => `${failure.name}: ${failure.status === undefined ? "unreachable or timed out" : `HTTP ${failure.status}`}`).join("\n")}\nAn engineer must investigate. This check does not identify an affected Tenant or prove recovery.`,
    );
  }
  // The join probe stays off until its Space, key and state binding are configured, so deploying this code changes nothing by itself.
  if (env.PROBE_SPACE_ID) {
    await runJoinProbe(env, api, sync, (message) => notify(webhook, message));
  }
  return { checked: results.length, failed: failures.length };
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // The monitor and the edge collector are independent lanes of the same tick:
    // Promise.allSettled runs both even when one fails, and the rejections are
    // thrown together so the failed lane still reports as an error.
    const settled = await Promise.allSettled([runMonitorCycle(env), collectEdge(env, controller.scheduledTime)]);
    const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected.length) throw new AggregateError(rejected.map((result) => result.reason), "uptime worker lane failed");
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") return Response.json({ worker: "chalk-uptime-worker" });
    if (!env.OPS_MANUAL_RUN_TOKEN || request.headers.get("authorization") !== `Bearer ${env.OPS_MANUAL_RUN_TOKEN}`) return Response.json({ error: "unauthorized" }, { status: 401 });
    try {
      return Response.json(await runMonitorCycle(env));
    } catch (error) {
      console.error("uptime cycle failed", error instanceof Error ? error.message : "unknown error");
      return Response.json({ error: "Uptime check or alert delivery failed" }, { status: 502 });
    }
  },
};
