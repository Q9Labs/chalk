import { postToOncall } from "../oncall-alert.mjs";

const WINDOW_MS = 10 * 60 * 1000;
const AXIOM_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";
const CLIENT_SIGNAL = "client_audio_stuck:chalk_sfu";
const MIN_PARTICIPANTS = 2;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const literal = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const evidenceField = (field) => `coalesce(tostring(evidence.${field}), tostring(column_ifexists('attributes.${field}', '')))`;
// An SDK from before client telemetry replays its earlier events in every report, so a row from the old route counts only
// when its report was sent for this type. A current SDK sends each event once.
const typeClause = (type) => ` and report_type == ${literal(type)} and (isempty(legacy_route) or trigger == ${literal(type)})`;
export function query(dataset) {
  return `[${literal(dataset)}]
| where ['service.name'] == 'chalk-api' and ['attributes.event'] == 'sdk.telemetry'
| extend evidence=parse_json(iff(body startswith 'chalk-evidence-v2:', substring(body, 18), '{}'))
| extend report_type=${evidenceField("type")}, legacy_route=${evidenceField("legacy_route")}, trigger=${evidenceField("trigger")}, provider_hint=${evidenceField("provider")}, participant=${evidenceField("participant_id_hash")}
| where ['attributes.event'] == 'sdk.telemetry'${typeClause("audio_receive_stuck")}
| where provider_hint == 'chalk_sfu'
| extend signal=${literal(CLIENT_SIGNAL)}
| summarize events=count() by episode_id=tostring(['attributes.episode_id']), signal, participant
| summarize events=sum(events), participants=countif(isnotempty(participant)) by episode_id, signal
| project episode_id, signal, events, participants`;
}

export function parseTabular(body) {
  const table = body?.tables?.[0];
  const malformed = () => {
    throw new Error("Axiom returned a malformed tabular response");
  };
  if (body?.status?.isPartial || body?.status?.isEstimate || body?.status?.messages?.some((m) => m.priority === "error")) malformed();
  if (!Array.isArray(body?.tables) || body.tables.length !== 1 || !Array.isArray(table?.fields) || !Array.isArray(table?.columns)) malformed();
  const names = table.fields.map((f) => f?.name);
  if (names.length !== 4 || new Set(names).size !== 4 || !["episode_id", "signal", "events", "participants"].every((n) => names.includes(n))) malformed();
  const columns = table.columns;
  if (columns.length !== 4 || !columns.every((c) => Array.isArray(c) && c.length === columns[0].length)) malformed();
  return columns[0]
    .map((_, i) => {
      const row = Object.fromEntries(names.map((name, j) => [name, columns[j][i]]));
      if (typeof row.episode_id !== "string" || typeof row.signal !== "string" || !Number.isSafeInteger(row.events) || row.events < 0 || !Number.isSafeInteger(row.participants) || row.participants < 0) malformed();
      return row;
    })
    .filter((row) => uuid.test(row.episode_id));
}

export function mergeEpisodes(rows) {
  const episodes = new Map();
  for (const { episode_id, signal, events, participants } of rows) {
    if (!uuid.test(episode_id)) continue;
    const id = episode_id.toLowerCase();
    const signals = episodes.get(id) ?? new Map();
    const seen = signals.get(signal) ?? { events: 0, participants: 0 };
    // Distinct counts cannot be added across rows, so keep the larger: it can only under-count, never page early.
    signals.set(signal, { events: seen.events + events, participants: Math.max(seen.participants, participants) });
    episodes.set(id, signals);
  }
  return [...episodes]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([episode_id, signals]) => {
      const sorted = [...signals].sort(([a], [b]) => a.localeCompare(b));
      return {
        episode_id,
        counts: Object.fromEntries(sorted.map(([signal, { events }]) => [signal, events])),
        participants: Object.fromEntries(sorted.map(([signal, { participants }]) => [signal, participants])),
        total: sorted.reduce((sum, [, { events }]) => sum + events, 0),
      };
    });
}

export function evaluate(rows, { startTime, endTime }) {
  return mergeEpisodes(rows)
    .filter((e) => e.participants[CLIENT_SIGNAL] >= MIN_PARTICIPANTS)
    .map((e) => ({
      key: `listener-audio:chalk:${e.episode_id}`,
      detail: `Listener audio missing. ${Object.entries(e.counts)
        .map(([signal, events]) => `${signal}: ${events}${e.participants[signal] ? ` (participants: ${e.participants[signal]})` : ""}`)
        .join(", ")}. UTC query window: ${startTime} to ${endTime}.`,
    }));
}

export async function readSignals({ fetchImpl = fetch, token, dataset, startTime, endTime }) {
  let response;
  try {
    response = await fetchImpl(AXIOM_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ apl: query(dataset), startTime, endTime }),
    });
  } catch {
    throw new Error("Axiom query request failed");
  }
  if (!response.ok) {
    // Axiom answers a bad query with a JSON reason. Keep the first line only: the rest echoes the submitted APL.
    let reason = "";
    try {
      const body = JSON.parse(await response.text());
      const raw = body?.detail?.message ?? body?.message;
      if (typeof raw === "string") reason = raw.split("\n", 1)[0].replaceAll(dataset, "<dataset>").replaceAll(token, "<token>").slice(0, 200);
    } catch {}
    throw new Error(`Axiom query answered HTTP ${response.status}${reason ? `: ${reason}` : ""}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Axiom returned invalid JSON");
  }
  return parseTabular(body);
}

export async function run({ env, fetchImpl = fetch, now = new Date(), log = console.log }) {
  const drill = env.LISTENER_AUDIO_CHECK_DRILL === "true";
  const required = ["ONCALL_WEBHOOK_URL", ...(!drill ? ["CHALK_AXIOM_QUERY_TOKEN", "CHALK_AXIOM_LOG_DATASET"] : [])];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  const window = { startTime: new Date(now.getTime() - WINDOW_MS).toISOString(), endTime: now.toISOString() };
  let incidents = [{ key: "listener-audio:chalk:00000000-0000-4000-8000-000000000001", detail: "Drill: test notification from the listener audio check. No missing audio was observed." }];
  if (!drill) {
    const rows = await readSignals({ fetchImpl, token: env.CHALK_AXIOM_QUERY_TOKEN, dataset: env.CHALK_AXIOM_LOG_DATASET, ...window });
    incidents = evaluate(rows, window);
    log(`${incidents.length} Episodes affected, ${rows.reduce((sum, row) => sum + row.events, 0)} events`);
  }
  if (!incidents.length) return 0;
  await postToOncall({ fetchImpl, url: env.ONCALL_WEBHOOK_URL, incidents, drill });
  // A fired alert fails the run so GitHub also emails the failure.
  return drill ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await run({ env: process.env });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
