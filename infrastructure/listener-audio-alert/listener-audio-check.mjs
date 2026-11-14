import { postToOncall } from "../oncall-alert.mjs";

export const EPISODE_THRESHOLD = 1;
const WINDOW_MS = 10 * 60 * 1000;
const AXIOM_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";
// api_unpulled exists only on Cloudflare SFU and goes away with it. The client report is provider-neutral and
// carries the provider from the participant's media credential; the query tags it onto the signal name.
export const PROVIDERS = ["cloudflare_sfu", "chalk_sfu"];
// A signal pages on EPISODE_THRESHOLD events unless it sets minParticipants: then it pages only when that many distinct
// participants reported it. One client can repeat or mis-report; the server-side sampler has no such doubt.
// Reports without a participant hash never count as a participant.
export const SIGNALS = [
  { name: "api_unpulled", event: "media.listener_publication_unpulled" },
  { name: "client_audio_stuck", event: "sdk.connection_report", trigger: "audio_receive_stuck", minParticipants: 2 },
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const literal = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const predicate = (signal) => `(['attributes.event'] == ${literal(signal.event)}${signal.trigger ? ` and ['attributes.trigger'] == ${literal(signal.trigger)}` : ""})`;

export function query(dataset) {
  return `[${literal(dataset)}]
| where ['service.name'] == 'chalk-api' and ['attributes.event'] in (${SIGNALS.map((s) => literal(s.event)).join(", ")})
| where ${SIGNALS.map(predicate).join(" or ")}
| extend provider=iff(tostring(['attributes.provider']) in (${PROVIDERS.map(literal).join(", ")}), tostring(['attributes.provider']), 'unknown')
| extend signal=case(${SIGNALS.map((s) => `${predicate(s)}, ${literal(s.name)}`).join(", ")}, '')
| extend signal=iff(signal == 'client_audio_stuck', strcat(signal, ':', provider), signal)
| extend participant=tostring(['attributes.participant_id_hash'])
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

// "client_audio_stuck:chalk_sfu" follows the rule of "client_audio_stuck"; an unlisted signal pages on any event.
function pages(signal, { events, participants }) {
  const minParticipants = SIGNALS.find((s) => signal === s.name || signal.startsWith(`${s.name}:`))?.minParticipants;
  return minParticipants ? participants >= minParticipants : events >= EPISODE_THRESHOLD;
}

export function evaluate(rows, { startTime, endTime }) {
  return mergeEpisodes(rows)
    .filter((e) => Object.entries(e.counts).some(([signal, events]) => pages(signal, { events, participants: e.participants[signal] })))
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
  if (!response.ok) throw new Error(`Axiom query answered HTTP ${response.status}`);
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
