import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { participantHash, normalizeRow } from "./rows.mjs";

const run = promisify(execFile);
const ROW_CAP = 5000;
const ID = /^[\w.:-]{1,128}$/u;
const CALL_EVENTS = ["http.failure"];
const CALL_EVENT_PREFIXES = ["sdk.", "media.", "sfu.", "sync."];

const quote = (id) => {
  if (!ID.test(id)) throw new Error(`refusing to put "${id.slice(0, 20)}" in a query: it is not an id`);
  return `'${id}'`;
};

async function axiom({ token, org, dataset, apl, start, end }, fetchImpl) {
  const response = await fetchImpl("https://api.axiom.co/v1/datasets/_apl?format=legacy", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(org ? { "x-axiom-org-id": org } : {}) },
    body: JSON.stringify({ apl: `['${dataset}'] | ${apl} | take ${ROW_CAP}`, startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() }),
  });
  if (!response.ok) throw new Error(`Axiom answered HTTP ${response.status} for dataset ${dataset}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  return (body.matches ?? []).map((match) => ({ _time: match._time, _rowId: match._rowId, ...match.data }));
}

/**
 * Runs a query that names optional fields. Axiom refuses a field the dataset has never seen, which is what a dataset
 * looks like before the build that logs the field is deployed; drop that field, say so, and ask again.
 */
async function withFields(fields, build, run, missing) {
  const present = new Set(fields);
  for (let attempt = 0; attempt <= fields.length; attempt += 1) {
    try {
      return await run(build(present));
    } catch (error) {
      const absent = /invalid field: \\?"attributes\.(\w+)\\?"/u.exec(error.message)?.[1];
      if (!absent || !present.delete(absent)) throw error;
      missing.push(`the dataset has no ${absent} field yet, so rows could not be reached through it`);
    }
  }
  return [];
}

async function database(url, episodeId) {
  if (!url) return { rows: [], missing: "CHALK_DATABASE_URL is not set, so the Episode and Participant rows were not read" };
  const sql = `select p.id, p.media_connection_id, coalesce(p.joined_at, e.created_at), e.ended_at, e.id from participants p join episodes e on e.id = p.episode_id where e.id = ${quote(episodeId)}::uuid`;
  const { stdout } = await run("psql", [url, "-X", "-A", "-t", "-F", "\t", "-c", sql]);
  const rows = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, connection, joinedAt, , episode] = line.split("\t");
      return { source: "db", event: "db.participant", time: Date.parse(joinedAt), episode, participant: participantHash(id), connection: connection || undefined, attrs: {} };
    });
  return { rows, missing: rows.length === 0 ? `the database has no Participants for Episode ${episodeId}` : undefined };
}

function callEventFilter() {
  const prefixes = CALL_EVENT_PREFIXES.map((prefix) => `['attributes.event'] startswith '${prefix}'`);
  const exact = CALL_EVENTS.map((event) => `['attributes.event'] == '${event}'`);
  return [...prefixes, ...exact].join(" or ");
}

/**
 * Reads every source for one Episode in three passes: by the Episode id, then by the connection, journey and trace ids
 * those rows name, then a probe for call events that name no id at all. The probe only counts rows that cannot be joined;
 * it never joins by time. `start` and `end` only bound how much of the dataset a query scans.
 */
export async function readSources({ episodeId, env, fetchImpl = fetch, now = Date.now() }) {
  const missing = [];
  const token = env.AXIOM_TOKEN;
  const logs = env.CHALK_LOG_DATASET;
  const traces = env.CHALK_TRACE_DATASET;
  if (!token || !logs) throw new Error("AXIOM_TOKEN and CHALK_LOG_DATASET are required");
  const start = now - 14 * 86_400_000;
  const scope = { token, org: env.AXIOM_ORG_ID, start, end: now };

  const [logRows, syncRows, db] = await Promise.all([
    axiom({ ...scope, dataset: logs, apl: `where ['attributes.episode_id'] == ${quote(episodeId)}` }, fetchImpl),
    traces ? axiom({ ...scope, dataset: traces, apl: `search ${JSON.stringify(episodeId)}` }, fetchImpl) : Promise.resolve([]),
    database(env.CHALK_DATABASE_URL, episodeId),
  ]);
  if (!traces) missing.push("CHALK_TRACE_DATASET is not set, so Sync spans were not read");
  if (db.missing) missing.push(db.missing);

  const first = [...logRows.map((row) => normalizeRow(row)), ...syncRows.map((row) => normalizeRow(row, "sync")), ...db.rows];
  const connections = [...new Set(first.map((row) => row.connection).filter(Boolean))].slice(0, 200);
  const links = [...new Set(first.flatMap((row) => [row.journey, row.trace]).filter(Boolean))].slice(0, 200);

  const ask =
    (dataset, window = {}) =>
    (apl) =>
      axiom({ ...scope, ...window, dataset, apl }, fetchImpl);
  const second = [];
  if (connections.length > 0 || links.length > 0) {
    const clauses = (present) => [
      ...(connections.length > 0 && present.has("connection_id") ? [`['attributes.connection_id'] in (${connections.map(quote).join(", ")})`] : []),
      ...(links.length > 0 && present.has("journey_id") ? [`['attributes.journey_id'] in (${links.map(quote).join(", ")})`] : []),
    ];
    const reached = await withFields(["connection_id", "journey_id"], (present) => (clauses(present).length > 0 ? `where ${clauses(present).join(" or ")}` : "where false"), ask(logs), missing);
    second.push(...reached.map((row) => normalizeRow(row)));
    if (traces && links.length > 0) {
      second.push(...(await axiom({ ...scope, dataset: traces, apl: `where ['trace_id'] in (${links.map(quote).join(", ")})` }, fetchImpl)).map((row) => normalizeRow(row, "sync")));
    }
  }

  const times = [...first, ...second].map((row) => row.time).filter(Number.isFinite);
  const window = { start: Math.min(...times) - 60_000, end: Math.max(...times) + 60_000 };
  const noIds = (present) =>
    ["episode_id", "connection_id", "journey_id"]
      .filter((name) => present.has(name))
      .map((name) => ` and isempty(tostring(['attributes.${name}']))`)
      .join("");
  const probe = times.length === 0 ? [] : await withFields(["episode_id", "connection_id", "journey_id"], (present) => `where (${callEventFilter()})${noIds(present)}`, ask(logs, window), missing);
  return { rows: dedupe([...first, ...second, ...probe.map((row) => normalizeRow(row))]), missing, truncated: [logRows, syncRows].some((rows) => rows.length >= ROW_CAP) };
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = row.attrs._rowId ?? JSON.stringify([row.source, row.time, row.event, row.connection, row.participant, row.attrs]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
