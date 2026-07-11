import { randomBytes } from "node:crypto";
import { waitFor } from "./poll.mjs";

const serviceName = "chalk-observability-smoke";
const canaryServiceName = "chalk-observability-canary";
const otlpEndpoint = "http://127.0.0.1:4318";
const traceId = randomBytes(16).toString("hex");
const spanId = randomBytes(8).toString("hex");
const now = BigInt(Date.now()) * 1_000_000n;
const start = now - 25_000_000n;

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
  const response = await fetch("http://127.0.0.1:3000/api/dashboards/uid/chalk-observability-v1");
  return response.ok;
});

await waitFor("Grafana alert rules", async () => {
  const response = await fetch("http://127.0.0.1:3000/api/v1/provisioning/alert-rules", {
    headers: {
      authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}`,
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
  return (
    ["chalk-collector-refused", "chalk-ledger-failures"].every((uid) => rulesByUid.has(uid)) &&
    expectedCanaryRules.every(([uid, signal]) => {
      const rule = rulesByUid.get(uid);
      return rule?.data?.[0]?.datasourceUid === "prometheus" && rule.data[0].model?.expr?.includes(`signal="${signal}"`);
    })
  );
});

for (const signal of ["metrics", "traces", "logs"]) {
  await waitFor(`canary ${signal} freshness`, () => hasPrometheusValue(`last_over_time(chalk_observability_canary_signal_fresh{service_name="${canaryServiceName}",signal="${signal}"}[5m])`, 1));
}

await waitFor("Tempo trace", async () => {
  const query = encodeURIComponent(`{ resource.service.name = "${serviceName}" }`);
  const response = await fetch(`http://127.0.0.1:3200/api/search?q=${query}`);
  if (!response.ok) return false;
  const body = await response.json();
  return body.traces?.some((trace) => trace.traceID === traceId) ?? false;
});

await waitFor("Prometheus metric", async () => {
  return hasPrometheusValue("chalk_observability_smoke_total", 1);
});

await waitFor("Loki log", async () => {
  const query = encodeURIComponent(`{service_name="${serviceName}"}`);
  const response = await fetch(`http://127.0.0.1:3100/loki/api/v1/query_range?query=${query}`);
  if (!response.ok) return false;
  const body = await response.json();
  return body.data?.result?.length > 0;
});

console.log(
  JSON.stringify(
    {
      dashboard: "chalk-observability-v1",
      alert_rules: ["chalk-collector-refused", "chalk-ledger-failures", "chalk-pipeline-stale", "chalk-pipeline-trace-stale", "chalk-pipeline-log-stale"],
      service: serviceName,
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
  const response = await fetch(`http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(query)}`);
  if (!response.ok) return false;
  const body = await response.json();
  return body.data?.result?.some((series) => Number(series.value?.[1]) >= expected) ?? false;
}
