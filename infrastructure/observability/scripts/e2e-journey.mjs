import { createJourneyIntakeExporter, createMemoryTelemetryStorage, createTelemetryClient } from "../../../sdks/typescript/client/dist/telemetry/index.js";
import { waitFor } from "./poll.mjs";

const apiBaseUrl = required("CHALK_E2E_API_URL");
const syncUrl = required("CHALK_E2E_SYNC_URL");
const token = required("CHALK_E2E_SYSTEM_TOKEN");
const grafanaBaseUrl = process.env.CHALK_E2E_GRAFANA_URL ?? "http://127.0.0.1:3000";
const tempoBaseUrl = process.env.CHALK_E2E_TEMPO_URL ?? "http://127.0.0.1:3200";
const lokiBaseUrl = process.env.CHALK_E2E_LOKI_URL ?? "http://127.0.0.1:3100";
const prometheusBaseUrl = process.env.CHALK_E2E_PROMETHEUS_URL ?? "http://127.0.0.1:9090";
const proofStartedAtSeconds = Date.now() / 1_000;
const exportedBatches = [];
const intake = createJourneyIntakeExporter({
  baseUrl: apiBaseUrl,
  headers: { Authorization: `Bearer ${token}` },
});
const telemetry = createTelemetryClient({
  enabled: true,
  exporter: async (events) => {
    exportedBatches.push(events.map((event) => structuredClone(event)));
    return intake(events);
  },
  storage: createMemoryTelemetryStorage(),
  retryDelayMs: 100,
});

const journey = telemetry.startJourney({
  kind: "observability.local_e2e",
  attributes: { surface: "local", media_provider: "cloudflare_sfu" },
});
journey.phase("authentication", { result: "system_token" });
journey.recordHttpRequest({ method: "POST", route: "/v1/telemetry/journey-events", state: "succeeded" });

const syncResult = await exerciseSync(journey);
journey.recordSyncFrame({ direction: "client_to_server", frameType: "hello", state: "succeeded" });
journey.recordSyncFrame({ direction: "server_to_client", frameType: "welcome", state: "succeeded" });
journey.recordRtcSummary(
  { connectionState: "connected", iceConnectionState: "connected", signalingState: "stable" },
  [
    { type: "inbound-rtp", bytesReceived: 24000, framesDropped: 1, jitter: 0.004, packetsLost: 1, packetsReceived: 240 },
    { type: "outbound-rtp", bytesSent: 18000, packetsSent: 180 },
    { type: "candidate-pair", roundTripTime: 0.018 },
  ],
  "succeeded",
);
journey.terminal("succeeded", { result: "local_e2e_passed" });
await telemetry.flush();

const exportedEvents = exportedBatches.flat();
const exportedNames = new Set(exportedEvents.map((event) => event.name));
const requiredNames = ["journey.started", "journey.phase", "http.request", "sync.frame", "rtc.summary", "journey.terminal"];
if (exportedEvents.length < 7 || requiredNames.some((name) => !exportedNames.has(name))) {
  throw new Error(`Expected a complete client journey, exported ${JSON.stringify(exportedEvents.map((event) => event.name))}`);
}

const duplicate = await intake(exportedEvents);
if (duplicate?.duplicate_count !== exportedEvents.length || duplicate.accepted_count !== 0) {
  throw new Error(`Duplicate replay was not idempotent: ${JSON.stringify(duplicate)}`);
}

const ledger = await json(`${apiBaseUrl}/v1/telemetry/journeys/${journey.context.journeyId}`, {
  headers: {
    Authorization: `Bearer ${token}`,
    ...journey.headers,
  },
});
if (ledger.terminal_state !== "succeeded" || ledger.events?.length !== exportedEvents.length) {
  throw new Error(`Durable ledger did not preserve the complete journey: ${JSON.stringify(ledger)}`);
}

await waitFor("Tempo trace containing API and sync services", async () => {
  const response = await fetch(`${tempoBaseUrl}/api/traces/${exportedEvents[0].trace_id}`);
  if (!response.ok) return false;
  const body = await response.text();
  return body.includes("chalk-api") && body.includes("chalk-sync") && body.includes("db.observability_journey_events.append") && body.includes("sync.room.event.committed") && body.includes(journey.context.journeyId);
});

await waitFor("correlated API log in Loki", async () => {
  const query = encodeURIComponent(`{service_name="chalk-api"} | journey_id="${journey.context.journeyId}"`);
  const response = await fetch(`${lokiBaseUrl}/loki/api/v1/query_range?query=${query}`);
  if (!response.ok) return false;
  const body = await response.text();
  return body.includes(journey.context.journeyId);
});

await waitFor("journey intake metrics in Prometheus", async () => {
  const [accepted, duplicates] = await Promise.all([prometheusSample("chalk_api_journey_events_accepted_total"), prometheusSample("chalk_api_journey_events_duplicates_total")]);
  return accepted.timestamp >= proofStartedAtSeconds && accepted.value >= exportedEvents.length && duplicates.timestamp >= proofStartedAtSeconds && duplicates.value >= exportedEvents.length;
});

const dashboardResponse = await fetch(`${grafanaBaseUrl}/api/dashboards/uid/chalk-observability-v1`);
if (!dashboardResponse.ok) {
  throw new Error(`Grafana dashboard lookup returned ${dashboardResponse.status}`);
}

telemetry.dispose();
console.log(
  JSON.stringify(
    {
      result: "passed",
      journey_id: journey.context.journeyId,
      trace_id: exportedEvents[0].trace_id,
      event_count: exportedEvents.length,
      duplicate_count: duplicate.duplicate_count,
      terminal_state: ledger.terminal_state,
      sync: syncResult,
      surfaces: ["postgres", "tempo", "prometheus", "loki", "grafana"],
    },
    null,
    2,
  ),
);

async function exerciseSync(activeJourney) {
  const claims = {
    tenant_id: "observability-local",
    room_id: `room-${activeJourney.context.journeyId}`,
    participant_id: "participant-local",
    display_name: "Local E2E",
  };
  const devToken = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const socket = new WebSocket(syncUrl);
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      token: devToken,
      ...syncCorrelation(activeJourney),
    }),
  );
  const welcome = await nextMessage(socket, (message) => message.type === "welcome");
  socket.send(
    JSON.stringify({
      type: "command",
      command_id: crypto.randomUUID(),
      name: "raise_hand",
      ...syncCorrelation(activeJourney),
    }),
  );
  const ack = await nextMessage(socket, (message) => message.type === "ack");
  socket.close(1000, "local proof complete");
  await once(socket, "close");

  if (welcome.journey_id !== activeJourney.context.journeyId || ack.journey_id !== activeJourney.context.journeyId) {
    throw new Error("Sync did not propagate the journey ID through welcome and ack frames");
  }
  return { welcome_mode: welcome.mode, ack_result: ack.result };
}

function syncCorrelation(activeJourney) {
  return {
    journey_id: activeJourney.context.journeyId,
    traceparent: activeJourney.context.traceparent,
    ...(activeJourney.context.tracestate ? { tracestate: activeJourney.context.tracestate } : {}),
  };
}

function once(target, eventName) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket ${eventName}`)), 5_000);
    target.addEventListener(
      eventName,
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
    target.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket failed before ${eventName}`));
      },
      { once: true },
    );
  });
}

function nextMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for a matching sync frame")), 5_000);
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });
}

async function json(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function prometheusSample(metric) {
  const query = encodeURIComponent(metric);
  const body = await json(`${prometheusBaseUrl}/api/v1/query?query=${query}`);
  const sample = body.data?.result?.[0]?.value;
  return {
    timestamp: Number(sample?.[0] ?? 0),
    value: Number(sample?.[1] ?? 0),
  };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
