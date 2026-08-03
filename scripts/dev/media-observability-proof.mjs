import process from "node:process";

import { MediaProofError, isRecord, waitFor } from "./media-smoke-core.mjs";

const LEDGER_DATASOURCE_UID = "chalk-journey-ledger";
const LEDGER_DATASOURCE_TYPE = "grafana-postgresql-datasource";
const DEFAULT_GRAFANA_URL = "http://127.0.0.1:3000";
const DEFAULT_TEMPO_URL = "http://127.0.0.1:3200";
const DEFAULT_LOKI_URL = "http://127.0.0.1:3100";
const DEFAULT_LEDGER_DATABASE = "chalk_dev";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const JOURNEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACE_ID = /^[0-9a-f]{16,64}$/i;

export const MEDIA_OBSERVABILITY_DEFAULTS = Object.freeze({
  grafanaURL: DEFAULT_GRAFANA_URL,
  tempoURL: DEFAULT_TEMPO_URL,
  lokiURL: DEFAULT_LOKI_URL,
  ledgerDatabase: DEFAULT_LEDGER_DATABASE,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  ledgerDatasourceUID: LEDGER_DATASOURCE_UID,
});

export function createMediaObservabilityProof(options = {}) {
  const settings = normalizeProofOptions(options);
  return ({ runtime, journeyIDs } = {}) => proveMediaObservability({ runtime, journeyIDs, ...settings });
}

export async function proveMediaObservability({ runtime, journeyIDs, ...options } = {}) {
  const settings = normalizeProofOptions(options);
  const candidates = [...new Set((Array.isArray(journeyIDs) ? journeyIDs : [journeyIDs]).filter((value) => typeof value === "string" && JOURNEY_ID.test(value)))];
  if (candidates.length === 0) throw new MediaProofError("observability_missing_journey_id", "Media smoke did not capture a valid journey ID");

  const state = { datasource: undefined, attempts: 0, last: undefined, proof: undefined };
  try {
    await waitFor(
      "local media observability proof",
      async () => {
        state.attempts += 1;
        for (const journeyID of candidates) {
          const result = await proveCandidate(journeyID, settings, state);
          if (result) {
            state.proof = result;
            return true;
          }
        }
        return false;
      },
      { timeoutMs: settings.timeoutMs, intervalMs: settings.pollIntervalMs, sleep: settings.sleep, now: settings.now },
    );
    return {
      status: "succeeded",
      runtimeID: runtime?.runtimeID,
      attempts: state.attempts,
      ...state.proof,
      local: {
        grafana: settings.grafanaURL.origin,
        tempo: settings.tempoURL.origin,
        loki: settings.lokiURL.origin,
      },
    };
  } catch (error) {
    if (error?.code === "timeout") {
      throw new MediaProofError("observability_proof_timeout", "Captured journey was not queryable in the local ledger, Tempo, and Loki before the proof deadline", {
        details: { journeyIDs: candidates, attempts: state.attempts, last: state.last },
      });
    }
    throw error;
  }
}

function normalizeProofOptions(options) {
  const env = options.env ?? process.env;
  const grafanaURL = localURL(options.grafanaURL ?? env.CHALK_DEV_GRAFANA_URL ?? env.CHALK_OBSERVABILITY_GRAFANA_URL ?? DEFAULT_GRAFANA_URL, "Grafana URL");
  const tempoURL = localURL(options.tempoURL ?? env.CHALK_DEV_TEMPO_URL ?? env.CHALK_OBSERVABILITY_TEMPO_URL ?? DEFAULT_TEMPO_URL, "Tempo URL");
  const lokiURL = localURL(options.lokiURL ?? env.CHALK_DEV_LOKI_URL ?? env.CHALK_OBSERVABILITY_LOKI_URL ?? DEFAULT_LOKI_URL, "Loki URL");
  const ledgerDatabase = options.ledgerDatabase ?? options.ledgerDatabaseName ?? env.CHALK_DEV_DATABASE_NAME ?? DEFAULT_LEDGER_DATABASE;
  return {
    grafanaURL,
    tempoURL,
    lokiURL,
    ledgerDatabase,
    ledgerDatasourceUID: options.ledgerDatasourceUID ?? LEDGER_DATASOURCE_UID,
    authorization: options.grafanaAuthorization ?? options.authorization ?? basicAuthorization("admin", "admin"),
    fetcher: options.fetcher ?? options.fetchImpl ?? options.fetch ?? globalThis.fetch,
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    pollIntervalMs: positiveInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    sleep: options.sleep,
    now: options.now,
  };
}

function localURL(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new MediaProofError("observability_invalid_url", `${name} must be an absolute HTTP URL`);
  }
  if (!/^https?:$/.test(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname)) throw new MediaProofError("observability_non_local_url", `${name} must point to localhost`);
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed;
}

async function proveCandidate(journeyID, settings, state) {
  if (!settings.fetcher) throw new MediaProofError("observability_fetch_unavailable", "Local observability proof requires fetch");
  const datasource = state.datasource ?? (await inspectDatasource(settings));
  if (!datasource) {
    state.last = { journeyID, ledger: "datasource_unavailable" };
    return false;
  }
  state.datasource = datasource;

  const ledger = await queryLedger(journeyID, settings, datasource);
  if (!ledger) {
    state.last = { journeyID, ledger: "journey_not_found" };
    return false;
  }
  const tempo = await queryTempo(journeyID, ledger.traceIDs, settings);
  const loki = await queryLoki(journeyID, settings);
  state.last = { journeyID, ledger: "found", tempo: tempo ? "found" : "pending", loki: loki ? "found" : "pending" };
  if (!tempo || !loki) return false;
  return { journeyID, ledger, tempo, loki };
}

async function inspectDatasource(settings) {
  const response = await request(settings.fetcher, new URL(`/api/datasources/uid/${settings.ledgerDatasourceUID}`, settings.grafanaURL), {
    headers: { authorization: settings.authorization },
  });
  if (!response?.ok) return undefined;
  const body = await readJSON(response);
  if (!isRecord(body) || body.uid !== settings.ledgerDatasourceUID || body.type !== LEDGER_DATASOURCE_TYPE) return undefined;
  const database = body.jsonData?.database ?? body.database;
  if (database !== settings.ledgerDatabase) return undefined;
  return { uid: body.uid, type: body.type, database };
}

async function queryLedger(journeyID, settings, datasource) {
  const rawSql = `SELECT journey_id::text, name, trace_id FROM observability_journey_events WHERE journey_id = '${journeyID}'::uuid ORDER BY sequence`;
  const response = await request(settings.fetcher, new URL("/api/ds/query", settings.grafanaURL), {
    method: "POST",
    headers: { authorization: settings.authorization, "content-type": "application/json" },
    body: JSON.stringify({
      from: String(Date.now() - 3_600_000),
      to: String(Date.now()),
      queries: [{ refId: "A", datasource: { uid: settings.ledgerDatasourceUID }, format: "table", rawQuery: true, rawSql }],
    }),
  });
  if (!response?.ok) return undefined;
  const body = await readJSON(response);
  const rows = rowsFromGrafana(body);
  const serialized = JSON.stringify(body);
  const fallbackFound = typeof serialized === "string" && serialized.includes(journeyID);
  if (rows.length === 0 && !fallbackFound) return undefined;
  const traceIDs = [...new Set(rows.map((row) => row.trace_id ?? row.traceId).filter((value) => typeof value === "string" && TRACE_ID.test(value)))];
  return { eventCount: rows.length || 1, traceIDs, datasource };
}

async function queryTempo(journeyID, traceIDs, settings) {
  for (const traceID of traceIDs) {
    const response = await request(settings.fetcher, new URL(`/api/traces/${encodeURIComponent(traceID)}`, settings.tempoURL));
    if (!response?.ok) continue;
    const body = await response.text();
    if (body.includes(journeyID)) return { traceID, matched: true };
  }
  const query = `{ .chalk.journey.id = "${journeyID}" }`;
  const url = new URL("/api/search", settings.tempoURL);
  url.searchParams.set("q", query);
  const response = await request(settings.fetcher, url);
  if (!response?.ok) return undefined;
  const body = await response.text();
  return body.includes(journeyID) ? { query: "journey_id", matched: true } : undefined;
}

async function queryLoki(journeyID, settings) {
  const query = `{service_name=~"chalk-.*"} | journey_id="${journeyID}"`;
  const url = new URL("/loki/api/v1/query_range", settings.lokiURL);
  url.searchParams.set("query", query);
  const response = await request(settings.fetcher, url);
  if (!response?.ok) return undefined;
  const body = await response.text();
  return body.includes(journeyID) ? { query: "journey_id", matched: true } : undefined;
}

function rowsFromGrafana(body) {
  const frames = body?.results?.A?.frames;
  if (!Array.isArray(frames)) return [];
  const rows = [];
  for (const frame of frames) {
    const values = frame?.data?.values;
    if (!Array.isArray(values)) continue;
    const names = frame.schema?.fields?.map((field) => field.name) ?? [];
    const count = Math.max(0, ...values.map((column) => (Array.isArray(column) ? column.length : 0)));
    for (let index = 0; index < count; index += 1) {
      const row = {};
      for (let column = 0; column < values.length; column += 1) row[names[column] ?? String(column)] = values[column]?.[index];
      rows.push(row);
    }
  }
  return rows;
}

async function request(fetcher, url, init) {
  try {
    return await fetcher(url, init);
  } catch {
    return undefined;
  }
}

async function readJSON(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
