import { randomBytes } from "node:crypto";

const endpoint = process.env.CHALK_OTLP_HTTP_ENDPOINT ?? "http://lgtm:4318";
const lokiEndpoint = process.env.CHALK_LOKI_ENDPOINT ?? "http://lgtm:3100";
const prometheusEndpoint = process.env.CHALK_PROMETHEUS_ENDPOINT ?? "http://lgtm:9090";
const tempoEndpoint = process.env.CHALK_TEMPO_ENDPOINT ?? "http://lgtm:3200";
const intervalMs = 60_000;
const processStart = BigInt(Date.now()) * 1_000_000n;
let count = 0;

await emitCanary();
if (process.env.CHALK_CANARY_RUN_ONCE !== "1") setInterval(() => void emitCanary(), intervalMs);

async function emitCanary() {
  count += 1;
  const cycleValue = Date.now();
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const now = BigInt(cycleValue) * 1_000_000n;
  const logMessage = `Chalk observability pipeline canary ${traceId}`;
  const resource = {
    attributes: [
      { key: "service.name", value: { stringValue: "chalk-observability-canary" } },
      { key: "deployment.environment.name", value: { stringValue: "local" } },
    ],
  };

  try {
    const results = await Promise.allSettled([
      send("/v1/traces", {
        resourceSpans: [{ resource, scopeSpans: [{ scope: { name: "chalk.observability.canary" }, spans: [{ traceId, spanId, name: "observability.pipeline.canary", kind: 1, startTimeUnixNano: (now - 1_000_000n).toString(), endTimeUnixNano: now.toString(), status: { code: 1 } }] }] }],
      }),
      send("/v1/metrics", {
        resourceMetrics: [
          {
            resource,
            scopeMetrics: [
              {
                scope: { name: "chalk.observability.canary" },
                metrics: [
                  { name: "chalk.observability.smoke", unit: "{run}", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ startTimeUnixNano: processStart.toString(), timeUnixNano: now.toString(), asInt: String(count) }] } },
                  { name: "chalk.observability.canary.cycle", gauge: { dataPoints: [{ timeUnixNano: now.toString(), asInt: String(cycleValue) }] } },
                ],
              },
            ],
          },
        ],
      }),
      send("/v1/logs", {
        resourceLogs: [{ resource, scopeLogs: [{ scope: { name: "chalk.observability.canary" }, logRecords: [{ timeUnixNano: now.toString(), observedTimeUnixNano: now.toString(), severityNumber: 9, severityText: "INFO", body: { stringValue: logMessage }, traceId, spanId }] }] }],
      }),
    ]);

    const [metrics, traces, logs] = await Promise.all([results[1].status === "fulfilled" && waitForFreshMetric(cycleValue), results[0].status === "fulfilled" && waitForFreshTrace(traceId), results[2].status === "fulfilled" && waitForFreshLog(logMessage)]);
    const signals = { metrics, traces, logs };
    await send("/v1/metrics", freshnessMetrics(resource, now, signals));

    const result = Object.values(signals).every(Boolean) ? "passed" : "failed";
    console.log(JSON.stringify({ count, emitted_at: new Date().toISOString(), result, signals, trace_id: traceId }));
  } catch (error) {
    console.error(JSON.stringify({ count, emitted_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), result: "failed" }));
  }
}

async function send(path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OTLP ${path} returned ${response.status}`);
}

function freshnessMetrics(resource, now, signals) {
  return {
    resourceMetrics: [
      {
        resource,
        scopeMetrics: [
          {
            scope: { name: "chalk.observability.canary" },
            metrics: [
              {
                name: "chalk.observability.canary.signal.fresh",
                gauge: {
                  dataPoints: Object.entries(signals).map(([signal, fresh]) => ({
                    attributes: [{ key: "signal", value: { stringValue: signal } }],
                    asInt: fresh ? "1" : "-1",
                    timeUnixNano: now.toString(),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

async function waitForFreshMetric(cycleValue) {
  return waitFor(async () => {
    const response = await fetch(`${prometheusEndpoint}/api/v1/query?${new URLSearchParams({ query: 'chalk_observability_canary_cycle{service_name="chalk-observability-canary"}' })}`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.data?.result?.some((series) => Number(series.value?.[1]) >= cycleValue) ?? false;
  });
}

async function waitForFreshTrace(traceId) {
  return waitFor(async () => (await fetch(`${tempoEndpoint}/api/traces/${traceId}`, { signal: AbortSignal.timeout(2_000) })).ok);
}

async function waitForFreshLog(logMessage) {
  return waitFor(async () => {
    const response = await fetch(
      `${lokiEndpoint}/loki/api/v1/query_range?${new URLSearchParams({
        query: `{service_name="chalk-observability-canary"} |= "${logMessage}"`,
        limit: "1",
      })}`,
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) return false;
    const body = await response.json();
    return body.data?.result?.length > 0;
  });
}

async function waitFor(check) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
