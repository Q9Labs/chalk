// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { axiom, chunks, quote, withFields } from "./axiom.mjs";
import { readDatabase } from "./database.mjs";
import { normalizeRow } from "./rows.mjs";

const DEADLINE_MS = 40_000;
const DAY_MS = 86_400_000;
const CALL_EVENTS = ["http.failure"];
const CALL_EVENT_PREFIXES = ["sdk.", "media.", "sfu.", "sync.", "participant."];

function callEventFilter() {
  const prefixes = CALL_EVENT_PREFIXES.map((prefix) => `['attributes.event'] startswith '${prefix}'`);
  const exact = CALL_EVENTS.map((event) => `['attributes.event'] == '${event}'`);
  return [...prefixes, ...exact].join(" or ");
}

/**
 * The span of time that holds the Episode. Axiom is asked only for this span, so a query scans an hour or two of the dataset
 * and not two weeks of it. Without the database there is no Episode time, so the whole read window is scanned.
 */
function episodeWindow(dbRows, read) {
  const episode = dbRows.find((row) => row.event === "db.episode");
  if (!episode) return read;
  const started = Date.parse(episode._time);
  const ended = episode.ended_at ? Date.parse(episode.ended_at) : read.end;
  return { start: Math.max(read.start, started - 10 * 60_000), end: Math.min(read.end, ended + 60 * 60_000) };
}

/**
 * Reads every source for one Episode: the database first (it names the Episode's span and each Participant's connection id), then
 * Axiom by the Episode id, then by the connection, journey and trace ids those rows name, then a probe for call events that
 * name no id at all. The probe only counts rows that cannot be joined; it never joins by time. One deadline covers every request
 * and the database read. A source that fails, is not configured, or is cut off by a cap is a gap in `gaps`, never a silent omission.
 */
export async function readSources({ episodeId, env, fetchImpl = fetch, now = Date.now(), deadlineMs = DEADLINE_MS, windowDays, readDb = readDatabase }) {
  const gaps = [];
  const signal = AbortSignal.timeout(deadlineMs);
  const tolerate = async (label, source, work, empty) => {
    try {
      return await work();
    } catch (error) {
      gaps.push({ source, blocks: true, what: `${label} could not be read (${signal.aborted ? `the ${deadlineMs / 1000} s deadline passed` : error.message.slice(0, 200)}), so the diagnosis leaves it out` });
      return empty;
    }
  };
  const token = env.AXIOM_TOKEN;
  const logs = env.CHALK_LOG_DATASET;
  const traces = env.CHALK_TRACE_DATASET;
  if (!token || !logs) throw new Error("AXIOM_TOKEN and CHALK_LOG_DATASET are required");
  const read = { start: now - windowDays * DAY_MS, end: now };

  const db = await tolerate("The database", "db", () => readDb({ url: env.CHALK_DATABASE_URL, episodeId, since: read.start, signal }), { rows: [], gaps: [] });
  gaps.push(...db.gaps);
  const dbRows = db.rows.map((row) => normalizeRow(row, "db"));
  const span = episodeWindow(db.rows, read);

  const scope = { token, org: env.AXIOM_ORG_ID, signal, ...span };
  const ask =
    (dataset, window = {}) =>
    (apl) =>
      axiom({ ...scope, ...window, dataset, apl }, fetchImpl);
  const note = (label, result) => {
    if (result.truncated) gaps.push({ source: "axiom", blocks: true, what: `${label} returned its row cap, so older rows may be missing` });
    return result.rows;
  };

  const [logRows, syncRows] = await Promise.all([
    tolerate("The log dataset", "axiom", async () => note("The query by Episode id", await ask(logs)(`where ['attributes.episode_id'] == ${quote(episodeId)}`)), []),
    traces ? tolerate("The trace dataset", "sync", async () => note("The Sync span query", await ask(traces)(`search ${JSON.stringify(episodeId)}`)), []) : Promise.resolve([]),
  ]);
  if (!traces) gaps.push({ source: "sync", blocks: true, what: "CHALK_TRACE_DATASET is not set, so Sync spans (socket up and down, admission, media control) were not read" });

  const first = [...logRows.map((row) => normalizeRow(row)), ...syncRows.map((row) => normalizeRow(row, "sync")), ...dbRows];
  const ids = (pick) => [...new Set(first.flatMap(pick).filter(Boolean))];
  const connections = ids((row) => [row.connection]);
  const links = ids((row) => [row.journey, row.trace]);

  const second = [];
  const reachedBy = (label, fields, list) =>
    tolerate(
      label,
      "axiom",
      async () => {
        const found = [];
        for (const part of chunks(list)) {
          const clauses = (present) => fields.filter(([name]) => present.has(name)).map(([name]) => `['attributes.${name}'] in (${part.map(quote).join(", ")})`);
          const result = await withFields(
            fields.map(([name]) => name),
            (present) => (clauses(present).length > 0 ? `where ${clauses(present).join(" or ")}` : "where false"),
            ask(logs),
            (absent) => gaps.push({ source: "axiom", blocks: false, what: `the dataset has no ${absent} field yet, so rows could not be reached through it` }),
          );
          found.push(...note(label, result));
        }
        return found;
      },
      [],
    );
  second.push(...(await reachedBy("The rows named by connection ids", [["connection_id"], ["provider_session_id"]], connections)).map((row) => normalizeRow(row)));
  second.push(...(await reachedBy("The rows named by journey ids", [["journey_id"]], links)).map((row) => normalizeRow(row)));
  if (traces && links.length > 0) {
    const spans = await tolerate(
      "The spans named by the trace ids",
      "sync",
      async () => {
        const found = [];
        for (const part of chunks(links)) found.push(...note("The Sync span query by trace id", await ask(traces)(`where ['trace_id'] in (${part.map(quote).join(", ")})`)));
        return found;
      },
      [],
    );
    second.push(...spans.map((row) => normalizeRow(row, "sync")));
  }

  const times = [...first, ...second].map((row) => row.time).filter(Number.isFinite);
  const window = { start: Math.min(...times) - 60_000, end: Math.max(...times) + 60_000 };
  const noIds = (present) =>
    ["episode_id", "connection_id", "provider_session_id", "journey_id"]
      .filter((name) => present.has(name))
      .map((name) => ` and isempty(tostring(['attributes.${name}']))`)
      .join("");
  const probe =
    times.length === 0
      ? []
      : await tolerate(
          "The probe for call events that name no id",
          "axiom",
          async () =>
            note(
              "The probe for call events that name no id",
              await withFields(
                ["episode_id", "connection_id", "provider_session_id", "journey_id"],
                (present) => `where (${callEventFilter()})${noIds(present)}`,
                ask(logs, window),
                () => {},
              ),
            ),
          [],
        );

  return { rows: dedupe([...first, ...second, ...probe.map((row) => normalizeRow(row))]), gaps };
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}
