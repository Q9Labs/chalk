export const EPISODE_THRESHOLD = 1;
const WINDOW_MS = 10 * 60 * 1000;
const AXIOM_URL = "https://api.axiom.co/v1/datasets/_apl?format=tabular";
// #721 can add sdk.connection_report with attributes.trigger == audio_receive_stuck here.
export const SIGNALS = [{ name: "api_unpulled", event: "media.listener_publication_unpulled" }];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const literal = (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const predicate = (signal) => `(['attributes.event'] == ${literal(signal.event)}${signal.trigger ? ` and ['attributes.trigger'] == ${literal(signal.trigger)}` : ""})`;

export function query(dataset) {
  return `[${literal(dataset)}]
| where ['service.name'] == 'chalk-api' and ['attributes.event'] in (${SIGNALS.map((s) => literal(s.event)).join(", ")})
| where ${SIGNALS.map(predicate).join(" or ")}
| extend signal=case(${SIGNALS.map((s) => `${predicate(s)}, ${literal(s.name)}`).join(", ")}, '')
| summarize count=count() by episode_id=tostring(['attributes.episode_id']), signal
| project episode_id, signal, count`;
}

export function parseTabular(body) {
  const table = body?.tables?.[0];
  const malformed = () => {
    throw new Error("Axiom returned a malformed tabular response");
  };
  if (body?.status?.isPartial || body?.status?.isEstimate || body?.status?.messages?.some((m) => m.priority === "error")) malformed();
  if (!Array.isArray(body?.tables) || body.tables.length !== 1 || !Array.isArray(table?.fields) || !Array.isArray(table?.columns)) malformed();
  const names = table.fields.map((f) => f?.name);
  if (names.length !== 3 || new Set(names).size !== 3 || !["episode_id", "signal", "count"].every((n) => names.includes(n))) malformed();
  const columns = table.columns;
  if (columns.length !== 3 || !columns.every((c) => Array.isArray(c) && c.length === columns[0].length)) malformed();
  return columns[0]
    .map((_, i) => {
      const row = Object.fromEntries(names.map((name, j) => [name, columns[j][i]]));
      if (typeof row.episode_id !== "string" || typeof row.signal !== "string" || !Number.isSafeInteger(row.count) || row.count < 0) malformed();
      return row;
    })
    .filter((row) => uuid.test(row.episode_id));
}

export function mergeEpisodes(rows) {
  const episodes = new Map();
  for (const { episode_id, signal, count } of rows) {
    if (!uuid.test(episode_id)) continue;
    const id = episode_id.toLowerCase();
    const counts = episodes.get(id) ?? new Map();
    counts.set(signal, (counts.get(signal) ?? 0) + count);
    episodes.set(id, counts);
  }
  return [...episodes]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([episode_id, counts]) => ({
      episode_id,
      counts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
      total: [...counts.values()].reduce((a, b) => a + b, 0),
    }));
}

export function evaluate(rows, { startTime, endTime }) {
  return mergeEpisodes(rows)
    .filter((e) => e.total >= EPISODE_THRESHOLD)
    .map((e) => ({
      key: `listener-audio:chalk:${e.episode_id}`,
      detail: `Listener audio missing. ${Object.entries(e.counts)
        .map(([signal, count]) => `${signal}: ${count}`)
        .join(", ")}. UTC query window: ${startTime} to ${endTime}.`,
    }));
}

export function oncallPayload(incidents, { drill }) {
  return { source: "oncall-poller", ...(drill ? { drill: true } : {}), incidents: incidents.map((incident) => ({ app: "chalk", kind: "new", ...incident })) };
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
    log(`${incidents.length} Episodes affected, ${rows.reduce((sum, row) => sum + row.count, 0)} events`);
  }
  if (!incidents.length) return 0;
  let response;
  try {
    response = await fetchImpl(env.ONCALL_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(oncallPayload(incidents, { drill })) });
  } catch {
    throw new Error("Oncall webhook request failed");
  }
  if (!response.ok) throw new Error(`Oncall webhook answered HTTP ${response.status}`);
  // A fired alert fails the run so GitHub also emails the failure.
  return drill ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await run({ env: process.env });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
