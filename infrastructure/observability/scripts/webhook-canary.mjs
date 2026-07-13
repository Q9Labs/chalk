import { Effect } from "effect";
import { createChalkEffectClient } from "../../../sdks/typescript/client/dist/index.js";
import { waitFor } from "./poll.mjs";

const apiBaseUrl = required("CHALK_WEBHOOK_CANARY_API_URL");
const token = required("CHALK_WEBHOOK_CANARY_TOKEN");
const tenantId = required("CHALK_WEBHOOK_CANARY_TENANT_ID");
const endpointId = required("CHALK_WEBHOOK_CANARY_ENDPOINT_ID");
const otlpEndpoint = process.env.CHALK_WEBHOOK_CANARY_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
const intervalSeconds = positiveInteger("CHALK_WEBHOOK_CANARY_INTERVAL_SECONDS", 300);
const once = process.argv.includes("--once");
const client = await Effect.runPromise(createChalkEffectClient({ baseUrl: apiBaseUrl, auth: { type: "bearer", token } }));

do {
  const startedAt = Date.now();
  const key = `signed-canary-${crypto.randomUUID()}`;
  const created = await Effect.runPromise(client.default.testWebhookEndpoint({ params: { tenant_id: tenantId, endpoint_id: endpointId }, headers: { "Idempotency-Key": key } }));
  let delivery;
  await waitFor(
    "configured signed webhook canary Delivery",
    async () => {
      delivery = await Effect.runPromise(client.default.getWebhookDelivery({ params: { tenant_id: tenantId, endpoint_id: endpointId, delivery_id: created.delivery_id } }));
      return delivery.state === "succeeded";
    },
    Math.max(30, intervalSeconds),
  );
  await emitSuccessMetric(Date.now());
  console.log(JSON.stringify({ event: "webhook.canary.succeeded", delivery_id: created.delivery_id, attempts: delivery.attempt_count, duration_ms: Date.now() - startedAt }));
  if (!once) await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
} while (!once);

async function emitSuccessMetric(nowMilliseconds) {
  const now = BigInt(nowMilliseconds) * 1_000_000n;
  const response = await fetch(`${otlpEndpoint}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "chalk-webhook-canary" } }] },
          scopeMetrics: [{ scope: { name: "chalk.webhook.canary" }, metrics: [{ name: "chalk.webhook.canary.last_success_unixtime", unit: "s", gauge: { dataPoints: [{ timeUnixNano: now.toString(), asDouble: nowMilliseconds / 1_000 }] } }] }],
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Webhook canary OTLP export returned ${response.status}: ${await response.text()}`);
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
