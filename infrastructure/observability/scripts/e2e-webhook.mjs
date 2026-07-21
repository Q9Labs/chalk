import { readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { createChalkEffectClient } from "../../../sdks/typescript/client/dist/effect.js";
import { createBrowserWebSocketFactory, createTelemetryClient, V3SyncClient } from "../../../sdks/typescript/client/dist/index.js";
import { waitFor } from "./poll.mjs";

const apiBaseUrl = required("CHALK_E2E_API_URL");
const syncUrl = required("CHALK_E2E_SYNC_URL");
const token = required("CHALK_E2E_SYSTEM_TOKEN");
const receiverUrl = required("CHALK_E2E_WEBHOOK_URL");
const receiverSecretFile = required("CHALK_WEBHOOK_RECEIVER_SECRET_FILE");
const receiverStateFile = required("CHALK_WEBHOOK_RECEIVER_STATE_FILE");
const restartRequestFile = required("CHALK_E2E_RESTART_REQUEST_FILE");
const restartCompleteFile = required("CHALK_E2E_RESTART_COMPLETE_FILE");
const hostSeedRequestFile = required("CHALK_E2E_HOST_SEED_REQUEST_FILE");
const hostSeedCompleteFile = required("CHALK_E2E_HOST_SEED_COMPLETE_FILE");
const grafanaBaseUrl = process.env.CHALK_E2E_GRAFANA_URL ?? "http://127.0.0.1:3000";
const tempoBaseUrl = process.env.CHALK_E2E_TEMPO_URL ?? "http://127.0.0.1:3200";
const lokiBaseUrl = process.env.CHALK_E2E_LOKI_URL ?? "http://127.0.0.1:3100";
const prometheusBaseUrl = process.env.CHALK_E2E_PROMETHEUS_URL ?? "http://127.0.0.1:9090";
const runId = crypto.randomUUID();
const coreEventTypes = ["room.created", "room.updated", "room.archived", "room.restored", "session.started", "session.ended", "participant.joined", "participant.left"];
const telemetry = createTelemetryClient({ enabled: true });
const journey = telemetry.startJourney({ kind: "observability.webhook_canary", attributes: { surface: "local_e2e" } });
const client = await Effect.runPromise(createChalkEffectClient({ baseUrl: apiBaseUrl, auth: { type: "bearer", token }, telemetry: journey.context }));

const tenant = await Effect.runPromise(client.tenants.createTenant({ payload: { name: `Webhook E2E ${runId}`, media_plane_provider_config: { enabled: false } } }));
const endpoint = await Effect.runPromise(
  client.default.createWebhookEndpoint({
    params: { tenant_id: tenant.id },
    headers: { "Idempotency-Key": idempotencyKey("endpoint") },
    payload: { name: "Signed webhook E2E", url: receiverUrl, enabled: true, api_version: 1, event_types: coreEventTypes },
  }),
);
await writeFile(receiverSecretFile, `${JSON.stringify({ secret: endpoint.secret })}\n`, { mode: 0o600 });

const room = await Effect.runPromise(
  client.rooms.createRoom({
    params: { tenant_id: tenant.id },
    payload: { name: "Webhook source", slug: `webhook-${runId}`, status: "active", media_plane: "cf_sfu" },
  }),
);

let delivery;
await waitFor(
  "webhook first retryable Attempt",
  async () => {
    const listed = await Effect.runPromise(client.default.listWebhookDeliveries({ params: { tenant_id: tenant.id, endpoint_id: endpoint.id }, query: { page_size: 100 } }));
    const roomDelivery = listed.deliveries.find((candidate) => candidate.event_type === "room.created");
    if (!roomDelivery) return false;
    delivery = await Effect.runPromise(client.default.getWebhookDelivery({ params: { tenant_id: tenant.id, endpoint_id: endpoint.id, delivery_id: roomDelivery.id } }));
    return delivery.state === "retry_wait" && delivery.attempts.length === 1 && delivery.attempts[0]?.outcome === "retryable_failure" && delivery.attempts[0]?.http_status === 503;
  },
  30,
);

await writeFile(restartRequestFile, `${JSON.stringify({ delivery_id: delivery.id, state: delivery.state })}\n`, { mode: 0o600 });
await waitFor(
  "API dispatcher restart",
  async () => {
    try {
      await readFile(restartCompleteFile);
      return (await fetch(`${apiBaseUrl}/readyz`)).ok;
    } catch {
      return false;
    }
  },
  30,
);

await waitFor(
  "retried signed webhook success",
  async () => {
    delivery = await Effect.runPromise(client.default.getWebhookDelivery({ params: { tenant_id: tenant.id, endpoint_id: endpoint.id, delivery_id: delivery.id } }));
    return delivery.state === "succeeded" && delivery.attempts.length === 2;
  },
  60,
);
assertAttempts(delivery.attempts, [
  { number: 1, outcome: "retryable_failure", status: 503 },
  { number: 2, outcome: "succeeded", status: 200 },
]);

const firstReceiverState = await receiverState();
const processorPhases = new Set(firstReceiverState.diagnostics?.map((diagnostic) => diagnostic.phase));
if (firstReceiverState.side_effect_count !== 1 || firstReceiverState.first_failure_signature_verified !== true || firstReceiverState.outcomes.join(",") !== "retryable_failure,processed" || !processorPhases.has("verified") || !processorPhases.has("completed")) {
  throw new Error(`Receiver did not process the signed retry exactly once: ${JSON.stringify(firstReceiverState)}`);
}

const redelivery = await Effect.runPromise(
  client.default.redeliverWebhookDelivery({
    params: { tenant_id: tenant.id, endpoint_id: endpoint.id, delivery_id: delivery.id },
    headers: { "Idempotency-Key": idempotencyKey("redeliver") },
  }),
);
let redeliveryDetail;
await waitFor(
  "manual redelivery duplicate acknowledgement",
  async () => {
    redeliveryDetail = await Effect.runPromise(client.default.getWebhookDelivery({ params: { tenant_id: tenant.id, endpoint_id: endpoint.id, delivery_id: redelivery.delivery_id } }));
    const state = await receiverState();
    return redeliveryDetail.state === "succeeded" && state.outcomes.at(-1) === "duplicate";
  },
  30,
);
const finalReceiverState = await receiverState();
if (finalReceiverState.side_effect_count !== 1 || finalReceiverState.handled_event_id !== delivery.event_id || finalReceiverState.last_event_id !== delivery.event_id) {
  throw new Error(`Manual redelivery changed the idempotent side effect: ${JSON.stringify(finalReceiverState)}`);
}

await Effect.runPromise(client.rooms.updateRoom({ params: { tenant_id: tenant.id, room_id: room.id }, payload: { name: "Webhook source updated" } }));
await Effect.runPromise(client.rooms.updateRoom({ params: { tenant_id: tenant.id, room_id: room.id }, payload: { status: "archived" } }));
await Effect.runPromise(client.rooms.updateRoom({ params: { tenant_id: tenant.id, room_id: room.id }, payload: { status: "active" } }));
const session = await Effect.runPromise(
  client.roomSessions.createRoomSession({
    params: { tenant_id: tenant.id, room_id: room.id },
    headers: { "Idempotency-Key": idempotencyKey("session") },
    payload: {
      started_at: new Date().toISOString(),
      admission_policy: "open",
      host_exit_policy: "require_transfer",
      role_capabilities: {
        host: ["publishAudio", "subscribe", "transferHost", "endMeeting"],
        cohost: ["publishAudio", "subscribe"],
        participant: ["subscribe"],
      },
      maximum_duration_seconds: 3600,
    },
  }),
);
const hostParticipantSessionId = crypto.randomUUID();
const hostAdmission = await Effect.runPromise(
  client.default.admitSessionParticipant({
    params: { tenant_id: tenant.id, room_id: room.id, session_id: session.id },
    headers: { "Idempotency-Key": idempotencyKey("host-admit") },
    payload: {
      participant_session_id: hostParticipantSessionId,
      name: "Webhook host",
      initial_role: "host",
      eligible_roles: ["host", "cohost", "participant"],
    },
  }),
);
await writeFile(hostSeedRequestFile, `${JSON.stringify({ tenant_id: tenant.id, room_id: room.id, session_id: session.id, participant_session_id: hostParticipantSessionId })}\n`, { mode: 0o600 });
let hostSeed;
await waitFor(
  "public Session bootstrap verification and production-mode Sync startup",
  async () => {
    try {
      hostSeed = JSON.parse(await readFile(hostSeedCompleteFile, "utf8"));
      return hostSeed.api_created_host_role === true && hostSeed.api_created_v3_control_policy === true;
    } catch {
      return false;
    }
  },
  60,
);
await waitForCoreDelivery("participant.joined");
let endpointSubscription = await Effect.runPromise(
  client.default.updateWebhookEndpoint({
    params: { tenant_id: tenant.id, endpoint_id: endpoint.id },
    headers: { "Idempotency-Key": idempotencyKey("subscription-no-join"), "If-Match": `"${endpoint.revision}"` },
    payload: { event_types: coreEventTypes.filter((eventType) => eventType !== "participant.joined") },
  }),
);
const guestParticipantSessionId = crypto.randomUUID();
const guestAdmission = await Effect.runPromise(
  client.default.admitSessionParticipant({
    params: { tenant_id: tenant.id, room_id: room.id, session_id: session.id },
    headers: { "Idempotency-Key": idempotencyKey("guest-admit") },
    payload: {
      participant_session_id: guestParticipantSessionId,
      name: "Webhook guest",
      initial_role: "participant",
      eligible_roles: ["participant"],
    },
  }),
);
const hostSync = await startV3Client(hostAdmission.sync_token, "host");
const guestSync = await startV3Client(guestAdmission.sync_token, "guest");
guestSync.leave({ commandId: crypto.randomUUID() }).catch(() => undefined);
await waitForCoreDelivery("participant.left");
endpointSubscription = await Effect.runPromise(
  client.default.updateWebhookEndpoint({
    params: { tenant_id: tenant.id, endpoint_id: endpoint.id },
    headers: { "Idempotency-Key": idempotencyKey("subscription-no-participants"), "If-Match": `"${endpointSubscription.revision}"` },
    payload: { event_types: coreEventTypes.filter((eventType) => eventType !== "participant.joined" && eventType !== "participant.left") },
  }),
);
hostSync.endSession({ commandId: crypto.randomUUID() }).catch(() => undefined);
await waitForCoreDelivery("session.ended");
guestSync.stop();
hostSync.stop();
const coreDeliveries = Object.fromEntries(await Promise.all(coreEventTypes.map(async (eventType) => [eventType, await waitForCoreDelivery(eventType)])));
const coreReceiverState = await receiverState();
for (const eventType of coreEventTypes) {
  if (coreReceiverState.side_effect_count_by_event?.[eventType] !== 1) {
    throw new Error(`Core Event ${eventType} did not produce exactly one durable side effect: ${JSON.stringify(coreReceiverState)}`);
  }
}
if (coreReceiverState.side_effect_count !== coreEventTypes.length) {
  throw new Error(`Core Events produced ${coreReceiverState.side_effect_count} side effects, want ${coreEventTypes.length}.`);
}

const canary = await Effect.runPromise(
  client.default.testWebhookEndpoint({
    params: { tenant_id: tenant.id, endpoint_id: endpoint.id },
    headers: { "Idempotency-Key": idempotencyKey("test") },
  }),
);
let canaryDetail;
await waitFor(
  "endpoint.test signed canary",
  async () => {
    canaryDetail = await Effect.runPromise(client.default.getWebhookDelivery({ params: { tenant_id: tenant.id, endpoint_id: endpoint.id, delivery_id: canary.delivery_id } }));
    return canaryDetail.state === "succeeded";
  },
  30,
);
if ((await receiverState()).side_effect_count !== coreEventTypes.length) throw new Error("endpoint.test changed the core Event side effect count.");

const ledger = await apiJSON(`/v1/telemetry/journeys/${journey.context.journeyId}`);
const requiredJourneyNames = ["webhook.event.committed", "webhook.delivery.queued", "webhook.delivery.attempt_started", "webhook.delivery.retry_scheduled", "webhook.delivery.attempt_succeeded"];
if (requiredJourneyNames.some((name) => !ledger.events.some((event) => event.name === name))) {
  throw new Error(`Webhook journey is incomplete: ${JSON.stringify(ledger)}`);
}
const tracedAttempt = ledger.events.find((event) => event.name === "webhook.delivery.attempt_started" && event.trace_id && event.span_id);
if (!tracedAttempt) throw new Error(`Webhook Attempt has no linked trace: ${JSON.stringify(ledger.events)}`);

await waitFor("webhook Attempt trace in Tempo", async () => {
  const response = await fetch(`${tempoBaseUrl}/api/traces/${tracedAttempt.trace_id}`);
  return response.ok && (await response.text()).includes("webhook.delivery.attempt");
});
await waitFor("content-free webhook completion logs in Loki", async () => {
  const query = new URLSearchParams({ query: `{service_name="chalk-api"} | journey_id="${journey.context.journeyId}"` });
  const response = await fetch(`${lokiBaseUrl}/loki/api/v1/query_range?${query}`);
  if (!response.ok) return false;
  const body = await response.text();
  if (!body.includes("webhook delivery attempt completed") || !body.includes(delivery.id)) return false;
  if (body.includes(endpoint.secret) || body.includes(receiverUrl) || body.includes("whsec_")) throw new Error("Webhook logs exposed a secret, destination, or raw credential marker.");
  return true;
});
await waitFor("webhook metrics in Prometheus", async () => {
  const queries = [
    'chalk_webhook_events_committed_total{event_name="room.created",api_version="1"}',
    'chalk_webhook_delivery_attempts_total{event_name="room.created",outcome="retryable_failure"}',
    'chalk_webhook_delivery_attempts_total{event_name="room.created",outcome="succeeded"}',
    'chalk_webhook_redelivery_results_total{outcome="accepted"}',
  ];
  const values = await Promise.all(queries.map(prometheusValue));
  return values.every((value) => value >= 1);
});
await verifyGrafanaJourneyLookup(journey.context.journeyId);

telemetry.dispose();
console.log(
  JSON.stringify(
    {
      result: "passed",
      journey_id: journey.context.journeyId,
      attempt_trace_id: tracedAttempt.trace_id,
      tenant_id: tenant.id,
      endpoint_id: endpoint.id,
      event_id: delivery.event_id,
      delivery_id: delivery.id,
      redelivery_id: redelivery.delivery_id,
      canary_delivery_id: canary.delivery_id,
      core_event_deliveries: Object.fromEntries(Object.entries(coreDeliveries).map(([eventType, detail]) => [eventType, detail.id])),
      core_event_side_effects: coreReceiverState.side_effect_count_by_event,
      attempts: delivery.attempts.map(({ number, outcome, http_status }) => ({ number, outcome, http_status })),
      receiver_requests: coreReceiverState.request_count,
      side_effect_count: coreReceiverState.side_effect_count,
      processor_verified_retry: true,
      first_failure_signature_verified: firstReceiverState.first_failure_signature_verified,
      processor_diagnostic_phases: [...processorPhases],
      api_created_host_role: hostSeed.api_created_host_role,
      api_created_v3_control_policy: hostSeed.api_created_v3_control_policy,
      surfaces: ["receiver", "public_sdk", "postgres", "tempo", "prometheus", "loki", "grafana"],
    },
    null,
    2,
  ),
);

function assertAttempts(attempts, expected) {
  for (const value of expected) {
    const attempt = attempts.find((entry) => entry.number === value.number);
    if (attempt?.outcome !== value.outcome || attempt.http_status !== value.status || !attempt.finished_at || attempt.latency_milliseconds === null) {
      throw new Error(`Attempt ${value.number} mismatch: ${JSON.stringify(attempts)}`);
    }
  }
}

async function receiverState() {
  return JSON.parse(await readFile(receiverStateFile, "utf8"));
}

async function waitForCoreDelivery(eventType) {
  let detail;
  await waitFor(
    `${eventType} signed delivery`,
    async () => {
      const listed = await Effect.runPromise(client.default.listWebhookDeliveries({ params: { tenant_id: tenant.id, endpoint_id: endpoint.id }, query: { page_size: 100 } }));
      const candidate = listed.deliveries.find((delivery) => delivery.event_type === eventType);
      if (!candidate) return false;
      detail = await Effect.runPromise(client.default.getWebhookDelivery({ params: { tenant_id: tenant.id, endpoint_id: endpoint.id, delivery_id: candidate.id } }));
      return detail.state === "succeeded" && detail.attempts.some((attempt) => attempt.outcome === "succeeded");
    },
    30,
  );
  return detail;
}

async function startV3Client(syncToken, label) {
  if (!syncToken) throw new Error(`${label} admission returned no Sync token.`);
  const syncClient = new V3SyncClient({
    url: syncUrl,
    token: async () => syncToken,
    webSocket: createBrowserWebSocketFactory(),
    lifecycle: {
      subscribe(listener) {
        listener("online");
        listener("active");
        return () => {};
      },
    },
    reconnectDelayMs: 100,
    retryDelayMs: 100,
  });
  await syncClient.start();
  await waitFor(`${label} v3 Sync recovery`, async () => syncClient.getSnapshot().connection.phase === "live", 30);
  return syncClient;
}

async function apiJSON(path) {
  const response = await fetch(`${apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${token}`, ...journey.headers } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function prometheusValue(query) {
  const response = await fetch(`${prometheusBaseUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
  if (!response.ok) return 0;
  const body = await response.json();
  return body.data?.result?.reduce((sum, series) => sum + Number(series.value?.[1] ?? 0), 0) ?? 0;
}

async function verifyGrafanaJourneyLookup(journeyId) {
  const authorization = `Basic ${Buffer.from("admin:admin").toString("base64")}`;
  const dashboard = await fetch(`${grafanaBaseUrl}/api/dashboards/uid/chalk-observability-v1`, { headers: { authorization } });
  if (!dashboard.ok) throw new Error(`Grafana dashboard lookup returned ${dashboard.status}`);
  const definition = await dashboard.json();
  if (!definition.dashboard?.templating?.list?.some((variable) => variable.name === "journey_id")) throw new Error("Grafana dashboard has no Journey ID lookup.");
  const response = await fetch(`${grafanaBaseUrl}/api/ds/query`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      from: String(Date.now() - 3_600_000),
      to: String(Date.now()),
      queries: [{ refId: "A", datasource: { uid: "chalk-journey-ledger" }, format: "table", rawQuery: true, rawSql: `SELECT journey_id::text, name FROM observability_journey_events WHERE journey_id = '${journeyId}'::uuid ORDER BY sequence` }],
    }),
  });
  if (!response.ok || !(await response.text()).includes(journeyId)) throw new Error(`Grafana could not look up webhook journey ${journeyId}.`);
}

function idempotencyKey(scope) {
  return `${scope}-${runId}`;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
