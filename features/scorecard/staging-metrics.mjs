// MPL gauges stay separate from API logs: the credentials have different scopes.
import { datasets } from "./staging-logs.mjs";

const instruments = { stealPercent: "chalk.sfu.host.cpu.steal", draining: "chalk.sfu.draining", sessions: "chalk.sfu.sessions" };
// MPL publishes no point limit. Apply the log collector's conservative cap to both axes.
const limit = 1000;

export async function readNodeMetrics(startTime, endTime, { env = process.env, fetchImpl = fetch } = {}) {
  const { metrics, metricsBaseUrl } = datasets(env);
  if (!/^[A-Za-z0-9_-]+$/.test(metrics ?? "") || !env.CHALK_AXIOM_METRICS_QUERY_TOKEN) throw new Error("staging_metrics_configuration_missing");
  const url = new URL("/v1/query/_mpl?format=metrics-v2", metricsBaseUrl);
  if (url.protocol !== "https:" || !["us-east-1.aws.edge.axiom.co", "eu-central-1.aws.edge.axiom.co"].includes(url.host)) throw new Error("staging_metrics_endpoint_invalid");
  const readouts = new Map();
  for (const [field, metric] of Object.entries(instruments)) {
    const response = await fetchImpl(url.href, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CHALK_AXIOM_METRICS_QUERY_TOKEN}`, "content-type": "application/json", accept: "application/vnd.metrics.v2+json" },
      body: JSON.stringify({ startTime, endTime, mpl: `\`${metrics}\`:\`${metric}\` | where \`service.name\` == "chalk-sfu" and \`deployment.environment.name\` == "staging" | align using max` }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 200) throw new Error("staging_metrics_query_failed");
    for (const [name, value] of response.headers ?? []) {
      if ((name.toLowerCase() === "link" && /\brel\s*=\s*"?next\b/i.test(value)) || (/continuation|truncat|partial|next.?page/i.test(name) && !["", "0", "false"].includes(value.toLowerCase()))) throw new Error("staging_metrics_query_incomplete");
    }
    const body = await response.json();
    if (!Array.isArray(body?.series) || body.series.length === 0) throw new Error("staging_metrics_query_empty");
    // Unknown metadata may announce a newer pagination protocol. Do not silently accept it.
    if (Object.keys(body).some((key) => !["metadata", "series"].includes(key)) || Object.keys(body.metadata ?? {}).some((key) => key !== "unit") || body.series.length >= limit) throw new Error("staging_metrics_query_incomplete");
    let points = 0;
    for (const series of body.series) {
      if (Object.keys(series).some((key) => !["metric", "tags", "start", "resolution", "data", "summary"].includes(key))) throw new Error("staging_metrics_query_incomplete");
      const instance = series.tags?.["service.instance.id"];
      if (series.metric !== metric || series.tags?.["service.name"] !== "chalk-sfu" || series.tags?.["deployment.environment.name"] !== "staging" || typeof instance !== "string" || !instance || !Array.isArray(series.data)) throw new Error("staging_metrics_query_malformed");
      points += series.data.length;
      if (points >= limit) throw new Error("staging_metrics_query_incomplete");
      const values = series.data.filter((value) => value !== null);
      if (values.length === 0) throw new Error("staging_metrics_query_empty");
      if (!values.every((value) => Number.isFinite(value) && value >= 0 && (field === "stealPercent" ? value <= 1 : field === "draining" ? value === 0 || value === 1 : Number.isSafeInteger(value)))) throw new Error("staging_metrics_query_malformed");
      const row = readouts.get(instance) ?? { nodeIncarnation: instance, host: {} };
      const value = Math.max(...values);
      if (field === "stealPercent") row.host.stealPercent = Math.max(row.host.stealPercent ?? 0, value * 100);
      else row[field] = field === "draining" ? row.draining || value === 1 : Math.max(row.sessions ?? 0, value);
      readouts.set(instance, row);
    }
  }
  return [...readouts.values()];
}
