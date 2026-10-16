export interface Env {
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
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Chalk-Uptime/1.0" } });
    await response.body?.cancel();
    return { name, healthy: response.status === 200, status: response.status };
  } catch {
    return { name, healthy: false };
  }
}

export async function runMonitorCycle(env: Env): Promise<{ readonly checked: number; readonly failed: number }> {
  if (!env.DISCORD_WEBHOOK_URL) throw new Error("DISCORD_WEBHOOK_URL must reuse the production Axiom alert channel webhook");
  const webhook = new URL(env.DISCORD_WEBHOOK_URL);
  if (webhook.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(webhook.hostname) || !webhook.pathname.startsWith("/api/webhooks/")) throw new Error("Invalid Discord webhook configuration");
  const api = baseURL(env.API_MONITOR_BASE_URL ?? env.API_BASE_URL ?? "https://api.chalkmeet.com");
  const sync = baseURL(env.SYNC_BASE_URL ?? "https://sync.chalkmeet.com");
  const results = await Promise.all([check("API health", new URL("/healthz", api)), check("API readiness", new URL("/readyz", api)), check("Sync health", new URL("/healthz", sync)), check("Sync readiness", new URL("/readyz", sync))]);
  const failures = results.filter((result) => !result.healthy);
  if (failures.length > 0) {
    const response = await fetch(webhook, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `Chalk uptime check failed\n${failures.map((failure) => `${failure.name}: ${failure.status === undefined ? "unreachable or timed out" : `HTTP ${failure.status}`}`).join("\n")}\nAn engineer must investigate. This check does not identify an affected Tenant or prove recovery.`,
        allowed_mentions: { parse: [] },
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Discord alert delivery failed (HTTP ${response.status})`);
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
    } catch {
      return Response.json({ error: "Uptime check or alert delivery failed" }, { status: 502 });
    }
  },
};
