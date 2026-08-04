import { createJourneyIntakeExporter, createMemoryTelemetryStorage, createTelemetryClient } from "../../../sdks/typescript/client/dist/telemetry/index.js";
import { Effect } from "effect";
import { createChalkEffectClient } from "../../../sdks/typescript/client/dist/effect.js";
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
  return body.includes("chalk-api") && body.includes("chalk-sync") && body.includes("db.observability_journey_events.append") && body.includes("sync.episode.event.committed") && body.includes(journey.context.journeyId);
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
  const fixture = await createEpisodeFixture(activeJourney);
  const socket = new WebSocket(syncUrl);
  await once(socket, "open");
  socket.send(
    JSON.stringify({
      type: "hello",
      protocol: 1,
      token: fixture.syncToken,
      streams: {
        control: { cursor: null },
        media: { cursor: null },
        presence: { cursor: null },
        requests: { cursor: null },
      },
      ...syncCorrelation(activeJourney),
    }),
  );
  const welcome = await nextMessage(socket, (message) => message.type === "welcome");
  socket.send(
    JSON.stringify({
      type: "recovery_ack",
      recovery_id: welcome.recovery_id,
      revision: welcome.head.revision,
      state_digest: welcome.head.state_digest,
    }),
  );
  await nextMessage(socket, (message) => message.type === "recovery_complete");
  await nextMessage(socket, (message) => message.type === "projection_snapshot" && message.stream === "media");
  await nextMessage(socket, (message) => message.type === "projection_snapshot" && message.stream === "presence");
  const commandId = crypto.randomUUID();
  const commit = waitForHandCommit(socket, commandId, fixture.participantId);
  socket.send(
    JSON.stringify({
      type: "command",
      command_id: commandId,
      name: "set_hand_raised",
      payload: { raised: true },
    }),
  );
  const { ack, event } = await commit;
  socket.send(JSON.stringify({ type: "delivery_ack", stream: "control", revision: event.revision, state_digest: event.resulting_state_digest }));
  socket.close(1000, "local proof complete");
  await once(socket, "close");

  return {
    tenant_id: fixture.tenantId,
    space_id: fixture.spaceId,
    episode_id: fixture.episodeId,
    participant_id: fixture.participantId,
    participant_generation: fixture.participantGeneration,
    role: fixture.role,
    capabilities: fixture.capabilities,
    welcome_mode: welcome.mode,
    ack_outcome: ack.outcome,
    event_name: event.name,
    event_revision: event.revision,
  };
}

function waitForHandCommit(socket, commandId, participantId) {
  return new Promise((resolve, reject) => {
    let ack;
    let event;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for hand command commit: command_id=${commandId} participant_id=${participantId}`));
    }, 5_000);
    const onMessage = (messageEvent) => {
      const message = JSON.parse(String(messageEvent.data));
      if (message.type === "ack" && message.command_id === commandId) {
        ack = message;
      } else if (message.type === "event" && message.stream === "control" && message.command_id === commandId && message.name === "hand_raised") {
        event = message;
      }
      if (!ack || !event) return;
      cleanup();
      if (ack.outcome !== "committed") {
        reject(new Error(`Sync hand command was not committed: command_id=${commandId} outcome=${String(ack.outcome).slice(0, 64)}`));
        return;
      }
      if (
        !Number.isSafeInteger(ack.revision) ||
        !Number.isSafeInteger(event.revision) ||
        !Number.isSafeInteger(event.base_revision) ||
        typeof ack.state_digest !== "string" ||
        typeof event.resulting_state_digest !== "string" ||
        event.payload?.participant_id !== participantId ||
        event.revision !== ack.revision ||
        event.resulting_state_digest !== ack.state_digest ||
        event.base_revision !== event.revision - 1
      ) {
        reject(new Error(`Sync hand commit mismatch: command_id=${commandId} participant_id=${participantId} event_revision=${String(event.revision)} ack_revision=${String(ack.revision)}`));
        return;
      }
      resolve({ ack, event });
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket failed while waiting for hand command commit: command_id=${commandId}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
  });
}

async function createEpisodeFixture(activeJourney) {
  const client = await Effect.runPromise(createChalkEffectClient({ baseUrl: apiBaseUrl, auth: { type: "bearer", token }, telemetry: activeJourney.context }));
  const tenant = await Effect.runPromise(client.tenants.createTenant({ payload: { name: `Observability Journey ${activeJourney.context.journeyId}`, media_plane_provider_config: { enabled: false } } }));
  const space = await Effect.runPromise(
    client.spaces.createSpace({
      params: { tenant_id: tenant.id },
      payload: {
        name: "Observability journey source",
        slug: `journey-${activeJourney.context.journeyId}`,
        media_plane: "cf_sfu",
        admission_policy: { mode: "open" },
        default_episode_duration_seconds: 3600,
        linger_window_seconds: 120,
        maximum_episode_duration_seconds: 3600,
      },
    }),
  );
  const episode = await Effect.runPromise(
    client.episodes.createEpisode({
      params: { tenant_id: tenant.id, space_id: space.id },
      headers: { "Idempotency-Key": idempotencyKey("episode") },
      payload: { started_at: new Date().toISOString(), metadata: { source: "observability-journey" } },
    }),
  );
  const participantId = crypto.randomUUID();
  let admission;
  try {
    admission = await Effect.runPromise(
      client.episodes.admitEpisodeParticipant({
        params: { tenant_id: tenant.id, space_id: space.id, episode_id: episode.id },
        headers: { "Idempotency-Key": idempotencyKey("participant") },
        payload: { participant_id: participantId, name: "Observability journey participant", role: "owner" },
      }),
    );
  } catch {
    throw new Error(`Episode admission request failed: tenant_id=${tenant.id} space_id=${space.id} episode_id=${episode.id} participant_id=${participantId}`);
  }
  if (
    !admission?.sync_token ||
    admission.participant?.id !== participantId ||
    !Number.isSafeInteger(admission.participant?.generation) ||
    admission.participant.generation < 1 ||
    admission.participant?.role !== "owner" ||
    !Array.isArray(admission.participant?.capabilities) ||
    admission.participant.capabilities.length === 0
  ) {
    const participant = admission?.participant;
    const generation = Number.isSafeInteger(participant?.generation) ? participant.generation : "invalid";
    const role = typeof participant?.role === "string" ? participant.role.slice(0, 64) : "missing";
    const capabilityCount = Array.isArray(participant?.capabilities) ? participant.capabilities.length : 0;
    throw new Error(`Episode admission fixture invalid: tenant_id=${tenant.id} space_id=${space.id} episode_id=${episode.id} participant_id=${participantId} generation=${generation} role=${role} capability_count=${capabilityCount}`);
  }
  return {
    tenantId: tenant.id,
    spaceId: space.id,
    episodeId: episode.id,
    participantId: admission.participant.id,
    participantGeneration: admission.participant.generation,
    role: admission.participant.role,
    capabilities: admission.participant.capabilities,
    syncToken: admission.sync_token,
  };
}

function syncCorrelation(activeJourney) {
  return {
    journey_id: activeJourney.context.journeyId,
    traceparent: activeJourney.context.traceparent,
    ...(activeJourney.context.tracestate ? { tracestate: activeJourney.context.tracestate } : {}),
  };
}

function idempotencyKey(scope) {
  return `observability-journey-${scope}-${crypto.randomUUID()}`;
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
