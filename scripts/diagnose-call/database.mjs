import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { quote } from "./axiom.mjs";

const run = promisify(execFile);

/**
 * psql reads the connection from PG* variables, so the URL, which holds the password, is never an argument that
 * `ps` shows. Only the settings the URL names are passed on, and the transaction is read-only.
 */
export function connectionEnv(url, base = process.env) {
  const parsed = new URL(url);
  const inherited = Object.fromEntries(Object.entries(base).filter(([name]) => name === "PATH" || name === "HOME" || name === "LANG" || name.startsWith("PG")));
  const settings = { sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", connect_timeout: "PGCONNECT_TIMEOUT" };
  const env = { ...inherited, PGHOST: parsed.hostname, PGPORT: parsed.port || "5432", PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password), PGDATABASE: parsed.pathname.slice(1), PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=20000" };
  for (const [name, variable] of Object.entries(settings)) {
    const value = parsed.searchParams.get(name);
    if (value) env[variable] = value;
  }
  return env;
}

/** The Episode the queries read, and the helper that writes one durable row as the JSON object the other sources use. */
function scoped(episodeId, since) {
  const ep = `ep as (select * from episodes where id = ${quote(episodeId)}::uuid and created_at >= ${quote(new Date(since).toISOString())}::timestamptz)`;
  const row = (id, time, event, fields, from) => `select jsonb_build_object('_rowId', ${id}, '_time', ${time}, 'event', '${event}', 'episode_id', ep.id${fields ? `, ${fields}` : ""}) from ${from}`;
  return { ep, row, join: (branches) => `with ${ep}\n${branches.join("\nunion all ")}` };
}

/**
 * Every durable fact about one Episode, one JSON object per line: the Episode and its Participants (`left_at`,
 * `last_left_reason`), presence leases, the participant lifecycle ledger (`participant.connection_expired`), SFU retirement
 * debts, Sync media pauses and stops, media refreshes and recordings. `since` is the read window: an Episode older than it is not read.
 */
export function episodeSql(episodeId, since) {
  const { row, join } = scoped(episodeId, since);
  return join([
    row(
      "'db:episodes:' || left(ep.id::text, 8)",
      "ep.created_at",
      "db.episode",
      "'status', ep.status, 'started_at', ep.started_at, 'ended_at', ep.ended_at, 'end_reason', ep.end_reason, 'media_plane_provider', ep.config_snapshot->'media_plane_binding'->>'provider', 'media_plane_selected_by', ep.config_snapshot->'media_plane_binding'->>'selected_by'",
      "ep",
    ),
    row(
      "'db:participants:' || left(p.id::text, 8)",
      "coalesce(p.joined_at, p.created_at)",
      "db.participant",
      "'participant_id', p.id, 'role', p.role, 'status', p.status, 'generation', p.generation, 'joined_at', p.joined_at, 'left_at', p.left_at, 'last_left_reason', p.last_left_reason, 'connection_id', p.media_connection_id",
      "ep join participants p on p.episode_id = ep.id",
    ),
    row("'db:presence_lease:' || left(l.participant_id::text, 8)", "l.expires_at", "db.presence_lease", "'participant_id', l.participant_id, 'generation', l.generation", "ep join participant_presence_leases l on l.episode_id = ep.id"),
    row(
      "'db:journey:' || left(j.event_id::text, 8)",
      "j.occurred_at",
      "db.journey_event",
      "'journey_name', j.name, 'journey_id', j.journey_id::text, 'trace_id', j.trace_id, 'participant_id_hash', j.attributes->>'participant_id_hash', 'expiry_path', j.attributes->>'expiry_path', 'last_seen_age_ms', j.attributes->>'last_seen_age_ms'",
      "ep join observability_journey_events j on j.attributes->>'episode_id' = ep.id::text",
    ),
    row("'db:sfu_debt:' || d.node || ':' || d.generation", "d.created_at", "db.sfu_retirement_debt", "'node', d.node, 'generation', d.generation, 'attempts', d.attempts", "ep join sfu_retirement_debts d on d.episode_id = ep.id"),
    row("'db:media_pause:' || left(m.participant_id::text, 8) || ':' || m.source", "m.created_at", "db.sync_media_pause", "'participant_id', m.participant_id, 'source', m.source", "ep join sync_media_pauses m on m.episode_id = ep.id"),
    row("'db:media_stop:' || left(m.participant_id::text, 8) || ':' || m.source", "m.created_at", "db.sync_media_stop", "'participant_id', m.participant_id, 'source', m.source, 'revision', m.revision", "ep join sync_media_stops m on m.episode_id = ep.id"),
    row("'db:media_refresh:' || left(r.participant_id::text, 8) || ':' || left(r.connection_id, 8)", "r.created_at", "db.media_refresh", "'participant_id', r.participant_id, 'connection_id', r.connection_id", "ep join participant_media_refreshes r on r.episode_id = ep.id"),
    row("'db:recording:' || left(r.recording_id::text, 8)", "r.created_at", "db.recording", "'status', r.status, 'failure_code', r.failure_code", "ep join sync_recordings r on r.episode_id = ep.id"),
  ]);
}

/**
 * How each media session of the Episode ended, from `participant_media_sessions`: one durable row per session with the same outcome fields
 * the node logs on `sfu.session.closed`. Axiom keeps 30 days and this table keeps the Episode's life, so it answers for an older call.
 */
export function sessionsSql(episodeId, since) {
  const { row, join } = scoped(episodeId, since);
  return join([
    row(
      "'db:media_session:' || left(s.connection_id, 12)",
      "s.ended_at",
      "db.media_session",
      "'participant_id', s.participant_id, 'generation', s.generation, 'connection_id', s.connection_id, 'cause', s.cause, 'outcome', s.outcome, 'connected', s.connected, 'lifetime_ms', s.lifetime_ms, 'connect_ms', s.connect_ms, 'disconnects', s.disconnects, 'outage_ms', s.outage_ms",
      "ep join participant_media_sessions s on s.episode_id = ep.id",
    ),
  ]);
}

/**
 * The changes to a media plane setting made while the Episode lasted, from `media_plane_changes`: its Space's, its Tenant's, and the global kill switch.
 * An Episode keeps the plane it was bound to, so a change in this window tells what later Episodes got, and what to suspect for a call that switched plane.
 */
export function planesSql(episodeId, since) {
  const { row, join } = scoped(episodeId, since);
  return join([
    row(
      "'db:media_plane_change:' || c.id",
      "c.changed_at",
      "db.media_plane_change",
      "'scope', c.scope, 'old_plane', c.old_plane, 'new_plane', c.new_plane, 'actor', c.actor, 'reason', c.reason, 'trace_id', c.trace_id",
      "ep join media_plane_changes c on c.changed_at >= ep.created_at and c.changed_at <= coalesce(ep.ended_at, now()) and (c.scope = 'kill_switch' or (c.scope = 'tenant' and c.tenant_id = ep.tenant_id) or (c.scope = 'space' and c.space_id = ep.space_id))",
    ),
  ]);
}

async function query(url, sql, signal) {
  const { stdout } = await run("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { signal, env: connectionEnv(url) }).catch((error) => {
    throw new Error(
      `psql failed: ${String(error.stderr ?? error.message)
        .trim()
        .split("\n")[0]
        .slice(0, 200)}`,
    );
  });
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * The durable tables the Episode query does not need: they are read on their own, so a database that does not have one yet
 * (the media session and plane change tables ship with the node's outcome fields) leaves the Episode's own rows intact and names the table as a gap that does not block.
 */
async function readOptional({ url, sql, signal, table, why }) {
  try {
    return { rows: await query(url, sql, signal), gaps: [] };
  } catch (error) {
    return { rows: [], gaps: [{ source: "db", blocks: false, what: `${table} could not be read (${error.message.slice(0, 160)}), so ${why}` }] };
  }
}

/** Reads the database rows of one Episode, or says why it could not. */
export async function readDatabase({ url, episodeId, since, signal }) {
  if (!url) return { rows: [], gaps: [{ source: "db", blocks: true, what: "CHALK_DATABASE_URL is not set, so the Episode, its Participants, leave reasons, leases, debts and Sync pauses were not read" }] };
  const [rows, sessions, planes] = await Promise.all([
    query(url, episodeSql(episodeId, since), signal),
    readOptional({ url, sql: sessionsSql(episodeId, since), signal, table: "participant_media_sessions", why: "how each media session ended is known only from the node's log lines" }),
    readOptional({ url, sql: planesSql(episodeId, since), signal, table: "media_plane_changes", why: "changes to the media plane setting during the Episode are not known" }),
  ]);
  const found = rows.some((row) => row.event === "db.episode");
  const missing = [{ source: "db", blocks: true, what: `the database has no Episode ${episodeId} inside the read window (it starts ${new Date(since).toISOString().slice(0, 10)}), so its Participants were not read` }];
  if (!found) return { rows, gaps: missing };
  return { rows: [...rows, ...sessions.rows, ...planes.rows], gaps: [...sessions.gaps, ...planes.gaps] };
}
