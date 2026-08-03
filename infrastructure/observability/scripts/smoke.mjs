import { randomBytes } from "node:crypto";
import { waitFor } from "./poll.mjs";

const serviceName = "chalk-observability-smoke";
const canaryServiceName = "chalk-observability-canary";
const grafanaBaseUrl = baseUrl("CHALK_OBSERVABILITY_GRAFANA_URL", "http://127.0.0.1:3000");
const collectorBaseUrl = baseUrl("CHALK_OBSERVABILITY_COLLECTOR_URL", "http://127.0.0.1:13133");
const lokiBaseUrl = baseUrl("CHALK_OBSERVABILITY_LOKI_URL", "http://127.0.0.1:3100");
const otlpEndpoint = baseUrl("CHALK_OBSERVABILITY_OTLP_HTTP_URL", "http://127.0.0.1:4318");
const prometheusBaseUrl = baseUrl("CHALK_OBSERVABILITY_PROMETHEUS_URL", "http://127.0.0.1:9090");
const tempoBaseUrl = baseUrl("CHALK_OBSERVABILITY_TEMPO_URL", "http://127.0.0.1:3200");
const grafanaAuthorization = `Basic ${Buffer.from("admin:admin").toString("base64")}`;
const ledgerDatasourceUid = "chalk-journey-ledger";
const ledgerDatasourceType = "grafana-postgresql-datasource";
const traceId = randomBytes(16).toString("hex");
const spanId = randomBytes(8).toString("hex");
const now = BigInt(Date.now()) * 1_000_000n;
const start = now - 25_000_000n;
let ledgerDatasource;

await Promise.all([
  waitFor("Grafana readiness", () => endpointIsReady(`${grafanaBaseUrl}/api/health`)),
  waitFor("OpenTelemetry Collector readiness", () => endpointIsReady(`${collectorBaseUrl}/ready`)),
  waitFor("Prometheus readiness", () => endpointIsReady(`${prometheusBaseUrl}/-/ready`)),
  waitFor("Tempo readiness", () => endpointIsReady(`${tempoBaseUrl}/ready`)),
  waitFor("Loki readiness", () => endpointIsReady(`${lokiBaseUrl}/ready`)),
]);

await waitFor("Grafana journey-ledger datasource", async () => {
  ledgerDatasource = await inspectLedgerDatasource();
  return ledgerDatasource !== null;
});

const resource = {
  attributes: [
    { key: "service.name", value: { stringValue: serviceName } },
    { key: "service.version", value: { stringValue: "smoke" } },
    {
      key: "deployment.environment.name",
      value: { stringValue: "local" },
    },
  ],
};

await send("/v1/traces", {
  resourceSpans: [
    {
      resource,
      scopeSpans: [
        {
          scope: { name: "chalk.observability.smoke" },
          spans: [
            {
              traceId,
              spanId,
              name: "observability.pipeline.smoke",
              kind: 1,
              startTimeUnixNano: start.toString(),
              endTimeUnixNano: now.toString(),
              attributes: [
                {
                  key: "chalk.journey.id",
                  value: { stringValue: `smoke-${traceId}` },
                },
              ],
              status: { code: 1 },
            },
          ],
        },
      ],
    },
  ],
});

await send("/v1/metrics", {
  resourceMetrics: [
    {
      resource,
      scopeMetrics: [
        {
          scope: { name: "chalk.observability.smoke" },
          metrics: [
            {
              name: "chalk.observability.smoke",
              unit: "{run}",
              sum: {
                aggregationTemporality: 2,
                isMonotonic: true,
                dataPoints: [
                  {
                    timeUnixNano: now.toString(),
                    asInt: "1",
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
});

await send("/v1/logs", {
  resourceLogs: [
    {
      resource,
      scopeLogs: [
        {
          scope: { name: "chalk.observability.smoke" },
          logRecords: [
            {
              timeUnixNano: now.toString(),
              observedTimeUnixNano: now.toString(),
              severityNumber: 9,
              severityText: "INFO",
              body: { stringValue: "Chalk observability pipeline smoke" },
              traceId,
              spanId,
              attributes: [
                {
                  key: "chalk.journey.id",
                  value: { stringValue: `smoke-${traceId}` },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

await waitFor("Grafana dashboard", async () => {
  const response = await fetch(`${grafanaBaseUrl}/api/dashboards/uid/chalk-observability-v1`);
  if (!response.ok) return false;
  const body = await response.json();
  const panels = new Set(body.dashboard?.panels?.map((panel) => panel.id));
  const variables = new Set(body.dashboard?.templating?.list?.map((variable) => variable.name));
  return [8, 9, 10, 11, 12, 13].every((id) => panels.has(id)) && variables.has("journey_id");
});

await waitFor("Grafana alert rules", async () => {
  const response = await fetch(`${grafanaBaseUrl}/api/v1/provisioning/alert-rules`, {
    headers: {
      authorization: grafanaAuthorization,
    },
  });
  if (!response.ok) return false;
  const body = await response.json();
  const rulesByUid = new Map(body.map((rule) => [rule.uid, rule]));
  const expectedCanaryRules = [
    ["chalk-pipeline-stale", "metrics"],
    ["chalk-pipeline-trace-stale", "traces"],
    ["chalk-pipeline-log-stale", "logs"],
  ];
  const expectedWebhookRules = [
    ["chalk-webhook-oldest-eligible", "chalk_webhook_delivery_oldest_eligible_age_seconds"],
    ["chalk-webhook-first-attempt-p99", "chalk_webhook_delivery_first_attempt_latency_seconds_bucket"],
    ["chalk-webhook-exhausted", "chalk_webhook_deliveries_terminal_total"],
    ["chalk-webhook-lease-churn", "chalk_webhook_delivery_lease_expiries_total"],
    ["chalk-webhook-journey-branch-stuck", "chalk_webhook_journey_oldest_unterminated_branch_age_seconds"],
    ["chalk-webhook-cleanup-stale", "chalk_webhook_cleanup_last_success_age_seconds"],
    ["chalk-webhook-canary-missing", "chalk_webhook_canary_last_success_unixtime"],
  ];
  return (
    ["chalk-collector-refused", "chalk-ledger-failures"].every((uid) => rulesByUid.has(uid)) &&
    expectedCanaryRules.every(([uid, signal]) => {
      const rule = rulesByUid.get(uid);
      return rule?.data?.[0]?.datasourceUid === "prometheus" && rule.data[0].model?.expr?.includes(`signal="${signal}"`);
    }) &&
    expectedWebhookRules.every(([uid, metric]) => {
      const rule = rulesByUid.get(uid);
      return rule?.data?.[0]?.datasourceUid === "prometheus" && rule.data[0].model?.expr?.includes(metric);
    })
  );
});

for (const signal of ["metrics", "traces", "logs"]) {
  await waitFor(`canary ${signal} freshness`, () => hasPrometheusValue(`last_over_time(chalk_observability_canary_signal_fresh{service_name="${canaryServiceName}",signal="${signal}"}[5m])`, 1));
}

await waitFor("Tempo trace", async () => {
  const query = encodeURIComponent(`{ resource.service.name = "${serviceName}" }`);
  const response = await fetch(`${tempoBaseUrl}/api/search?q=${query}`);
  if (!response.ok) return false;
  const body = await response.json();
  return body.traces?.some((trace) => trace.traceID?.padStart(32, "0") === traceId) ?? false;
});

await waitFor("Prometheus metric", async () => {
  return hasPrometheusValue("chalk_observability_smoke_total", 1);
});

await waitFor("Loki log", async () => {
  const query = encodeURIComponent(`{service_name="${serviceName}"}`);
  const response = await fetch(`${lokiBaseUrl}/loki/api/v1/query_range?query=${query}`);
  if (!response.ok) return false;
  const body = await response.json();
  return body.data?.result?.length > 0;
});

console.log(
  JSON.stringify(
    {
      dashboard: "chalk-observability-v1",
      alert_rules: [
        "chalk-collector-refused",
        "chalk-ledger-failures",
        "chalk-pipeline-stale",
        "chalk-pipeline-trace-stale",
        "chalk-pipeline-log-stale",
        "chalk-webhook-oldest-eligible",
        "chalk-webhook-first-attempt-p99",
        "chalk-webhook-exhausted",
        "chalk-webhook-lease-churn",
        "chalk-webhook-journey-branch-stuck",
        "chalk-webhook-cleanup-stale",
        "chalk-webhook-canary-missing",
      ],
      service: serviceName,
      ledger_datasource: {
        database: ledgerDatasource.database,
        url: ledgerDatasource.url,
        uid: ledgerDatasource.uid,
      },
      trace_id: traceId,
      result: "passed",
    },
    null,
    2,
  ),
);

async function send(path, body) {
  const response = await fetch(`${otlpEndpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`OTLP ${path} returned ${response.status}: ${await response.text()}`);
  }
}

async function hasPrometheusValue(query, expected) {
  const response = await fetch(`${prometheusBaseUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
  if (!response.ok) return false;
  const body = await response.json();
  return body.data?.result?.some((series) => Number(series.value?.[1]) >= expected) ?? false;
}

async function endpointIsReady(url) {
  const response = await fetch(url);
  return response.ok;
}

async function inspectLedgerDatasource() {
  const response = await fetch(`${grafanaBaseUrl}/api/datasources/uid/${ledgerDatasourceUid}`, {
    headers: { authorization: grafanaAuthorization },
  });
  if (!response.ok) return null;

  const datasource = await response.json();
  if (datasource.uid !== ledgerDatasourceUid || datasource.type !== ledgerDatasourceType) return null;

  const queryResponse = await fetch(`${grafanaBaseUrl}/api/ds/query`, {
    method: "POST",
    headers: { authorization: grafanaAuthorization, "content-type": "application/json" },
    body: JSON.stringify({
      from: String(Date.now() - 60_000),
      to: String(Date.now()),
      queries: [
        {
          datasource: { uid: ledgerDatasourceUid },
          format: "table",
          rawQuery: true,
          rawSql: "SELECT 1 AS ready",
          refId: "A",
        },
      ],
    }),
  });
  if (!queryResponse.ok) return null;

  const query = await queryResponse.json();
  const ready = query.results?.A?.frames?.some((frame) => frame.data?.values?.some((column) => Array.isArray(column) && column.some((value) => value === 1 || value === "1"))) ?? false;
  if (!ready) return null;

  return {
    database: datasource.jsonData?.database ?? datasource.database,
    uid: datasource.uid,
    url: datasource.url,
  };
}

function baseUrl(name, fallback) {
  return (process.env[name] ?? fallback).replace(/\/+$/, "");
}
