import { runJoinProbe, type ProbeEnv } from "./probe";

export interface Env extends ProbeEnv {
  API_BASE_URL?: string;
  API_MONITOR_BASE_URL?: string;
  SYNC_BASE_URL?: string;
  /** Same Discord webhook input used by the Axiom monitor provisioner. */
  DISCORD_WEBHOOK_URL?: string;
  OPS_MANUAL_RUN_TOKEN?: string;
}

type CheckResult = { readonly name: string; readonly healthy: boolean; readonly status?: number };

function baseURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Monitor targets require HTTPS without credentials");
  return url;
}

async function check(name: string, url: URL): Promise<CheckResult> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Chalk-Uptime/1.0" } });
    await response.body?.cancel();
    return { name, healthy: response.status === 200, status: response.status };
  } catch {
    return { name, healthy: false };
  }
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
  const failures = results.filter((result) => !result.healthy);
  if (failures.length > 0) {
    await notify(
      webhook,
      `Chalk uptime check failed\n${failures.map((failure) => `${failure.name}: ${failure.status === undefined ? "unreachable or timed out" : `HTTP ${failure.status}`}`).join("\n")}\nAn engineer must investigate. This check does not identify an affected Tenant or prove recovery.`,
    );
  }
  // The join probe stays off until its Space, key and state binding are configured, so deploying this code changes nothing by itself.
  if (env.PROBE_SPACE_ID) {
    const message = await runJoinProbe(env, api, sync);
    if (message) await notify(webhook, message);
  }
  return { checked: results.length, failed: failures.length };
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runMonitorCycle(env);
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
