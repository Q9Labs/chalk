// @ts-check
/**
 * The slice-13 evidence reader: turns the real stores of a dev problem-report or live-introspection run into the `World`
 * that `diagnose --fixture` judges through the reference adapters in scripts/diagnose-call/proof/fixture-world.mjs.
 *
 * - `db` and `report` are the authority reads: episodes, participants, problem_reports, diagnostic_uploads,
 *   live_introspection_requests and telemetry_sources through psql on CHALK_DATABASE_URL. Every db observation claims the
 *   row as it stands at the read over `[row commit .. read]`.
 * - `client` and `sync` are the kernel rows committed to `telemetry_outbox.payload` (the durable store the EvidenceSink
 *   and telemetry ingest write), plus the client's ledger watermark from telemetry_sources.
 * - `api` is `api.log` under CHALK_DIAGNOSE_LOCAL_LOGS, read the same way as live/stores.mjs reads Axiom: rows map through
 *   the registry by event name.
 * - `r2` is the checker's own GET of each stored upload's object, gunzip + JSON parse + identity match, through
 *   scripts/diagnose-call/r2.mjs; CHALK_DIAGNOSE_R2_DIR reads a host directory, else the CHALK_R2_* SigV4 env.
 *
 * Honest coverage: an unread source gets complete_to_ms null; server sources (api, sync, sfu) are never complete.
 * Descriptions, diagnostics text, tokens and bundle bodies never enter observations.
 */
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { FACTS } from "../diagnose-call/proof/facts.mjs";
import { ITEM } from "../diagnose-call/proof/profile.mjs";
import { observationsFromRows } from "../diagnose-call/proof/rows.mjs";
import { r2Readback } from "../diagnose-call/r2.mjs";
import { reportRows, dbRows, eventId } from "../diagnose-call/live/report-store.mjs";

/** @typedef {import("../diagnose-call/proof/fixture-world.mjs").World} World */
/** @typedef {import("../diagnose-call/proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../diagnose-call/proof/evidence.mjs").Watermark} Watermark */
/** @typedef {Readonly<Record<string, unknown>>} Row */

const run = promisify(execFile);

const EMITS = (() => {
  const emits = new Map();
  for (const [fact, def] of Object.entries(FACTS)) for (const e of def.events) emits.set(e.source, [...(emits.get(e.source) ?? []), fact]);
  return new Map([...emits.entries()].map(([s, f]) => [s, [...new Set(f)].sort()]));
})();

export class EvidenceError extends Error {}

/** One JSON object per psql -c call. */
async function psql(url, sql) {
  const { stdout } = await run("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: { ...process.env, PGOPTIONS: "" }, maxBuffer: 32 << 20 }).catch((error) => {
    throw new EvidenceError(`psql failed: ${String(error.code ?? error.message)}`);
  });
  const text = stdout.trim();
  return text === "" ? null : JSON.parse(text);
}
const ms = (v) => (v === null || v === undefined ? null : Date.parse(v));

/**
 * Reads the Episode declaration: the Episode, tenant, seats (with status and left_at), and every seat's telemetry_sources
 * ledger rows.
 * @param {string} url @param {string} tenant @param {string} episode
 */
async function declarationOf(url, tenant, episode) {
  const q = `select json_build_object(
    'episode', (select json_build_object('id',id,'tenant_id',tenant_id,'space_id',space_id,'status',status,'created_at',created_at,'started_at',started_at,'ended_at',ended_at,'end_reason',end_reason) from episodes where id='${episode}'::uuid and tenant_id='${tenant}'::uuid),
    'seats', coalesce((select json_agg(json_build_object('participant',p.id,'status',p.status,'generation',p.generation,'connection',p.media_connection_id,'created_at',p.created_at,'joined_at',p.joined_at,'left_at',p.left_at) order by p.created_at) from participants p where p.episode_id='${episode}'::uuid and p.tenant_id='${tenant}'::uuid),'[]'::json),
    'reports', coalesce((select json_agg(json_build_object('id',r.id,'chk_code',r.chk_code,'journey_id',r.journey_id,'participant_id',r.participant_id,'client_session_id',r.client_session_id,'sdk_version',r.sdk_version,'picked_symptom',r.picked_symptom,'forward_outcome',r.forward_outcome,'created_at',r.created_at)) from problem_reports r where r.episode_id='${episode}'::uuid and r.tenant_id='${tenant}'::uuid),'[]'::json),
    'uploads', coalesce((select json_agg(json_build_object('id',u.id,'report_id',u.report_id,'live_request_id',u.live_request_id,'trigger',u.trigger,'state',u.state,'bytes',u.bytes,'sha256',u.sha256,'object_key',u.object_key,'issued_at',u.issued_at,'stored_at',u.stored_at,'failed_at',u.failed_at,'expires_at',u.expires_at)) from diagnostic_uploads u where u.episode_id='${episode}'::uuid and u.tenant_id='${tenant}'::uuid),'[]'::json),
    'requests', coalesce((select json_agg(json_build_object('id',l.id,'participant_id',l.participant_id,'requested_at',l.requested_at,'expires_at',l.expires_at,'participant_status',l.participant_status,'seat_left_at',l.seat_left_at,'episode_status',l.episode_status,'delivery',l.delivery,'delivered_at',l.delivered_at,'sockets',l.sockets,'unavailable_reason',l.unavailable_reason)) from live_introspection_requests l where l.episode_id='${episode}'::uuid and l.tenant_id='${tenant}'::uuid),'[]'::json),
    'sessions', coalesce((select json_agg(json_build_object('source_id',t.source_id,'participant_id',t.participant_id,'ranges',t.ranges,'reported_next_seq',t.reported_next_seq,'end_state',t.end_state,'end_next_seq',t.end_next_seq,'first_received_at',t.first_received_at,'last_received_at',t.last_received_at)) from telemetry_sources t where t.episode_id='${episode}'::uuid and t.tenant_id='${tenant}'::uuid),'[]'::json))`;
  return psql(url, q);
}

/**
 * Kernel rows of one Episode from telemetry_outbox payloads (client + sync sources). The payload is
 * [{service:{name}, attributes: record}] batched per source; every record carries episode_id.
 * @param {string} url @param {string} tenant @param {string} episode
 */
async function outboxRows(url, tenant, episode) {
  const rows = await psql(url, `select coalesce(json_agg(record), '[]'::json) from (
    select elem->'attributes' as record
    from telemetry_outbox o, lateral jsonb_array_elements(o.payload) elem
    where o.tenant_id = '${tenant}'::uuid and elem->'attributes'->>'episode_id' = '${episode}') x`);
  return rows ?? [];
}

/** api.log kernel rows for the episode. */
function apiRows(logRoot, episode) {
  const file = join(logRoot, "api.log");
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      const row = raw.attributes ?? raw;
      if (row.episode_id === episode || row.name === "problem_reports.config") out.push(row);
    } catch { /* not json */ }
  }
  return out;
}

/** r2 readback observations for every stored upload row. */
async function r2Observations(uploads, { tenant, episode }, env) {
  const obs = [];
  for (const u of uploads.filter((x) => x.state === "stored")) {
    const back = await r2Readback({ key: u.object_key, expect: { episode_id: episode, participant_id: u.participant_id, client_session_id: u.client_session_id }, env });
    obs.push(observation({
      id: eventId("ev", "report.r2_upload", u.id),
      fact: "report.readback", source: "r2", origin: origin.measured("r2"),
      subject: { tenant, episode },
      window: { from_ms: back.at_ms, to_ms: back.at_ms },
      claim: back.readback,
      value: { diagnostic_upload_id: u.id, readback: back.readback, ...(back.bytes != null ? { bytes: back.bytes } : {}), ...back.parts },
      failure: back.readback !== "ok",
      query: `r2 get ${u.object_key}`,
    }));
  }
  return obs;
}

/**
 * Builds the World for one Episode from the real stores.
 * @param {{ databaseUrl: string, tenant: string, episode: string, logRoot?: string, env?: NodeJS.ProcessEnv, asof_ms?: number }} input
 * @returns {Promise<{ world: World, notes: string[] }>}
 */
export async function episodeWorld({ databaseUrl, tenant, episode, logRoot, env = process.env, asof_ms = Date.now() }) {
  const db = await declarationOf(databaseUrl, tenant, episode);
  if (db.episode === null) throw new EvidenceError(`no Episode ${episode} in tenant ${tenant}`);
  const ep = db.episode;
  const window = { from_ms: ms(ep.started_at) ?? ms(ep.created_at), to_ms: ms(ep.ended_at) };
  const declaration = {
    kind: "episode",
    id: ep.id,
    tenant: ep.tenant_id,
    features: [],
    window,
    seats: (db.seats ?? []).map((p) => ({
      participant: p.participant,
      name: null,
      role: "participant",
      can_publish: true,
      generations: [p.generation ?? 1],
      connections: [],
      window: { from_ms: ms(p.joined_at) ?? ms(p.created_at), to_ms: ms(p.left_at) },
      person: { kind: "guest", device: null, name: null },
    })),
  };

  // Kernel rows: api.log + telemetry_outbox payloads.
  const rows = [
    ...apiRows(logRoot ?? env.CHALK_DIAGNOSE_LOCAL_LOGS ?? "", ep.id),
    ...(await outboxRows(databaseUrl, ep.tenant_id, ep.id)),
  ];
  const { observations: kernelObs, dropped } = observationsFromRows(rows);

  const sessions = db.sessions ?? [];
  // sdk_version per client session: newest delivered record's build field.
  for (const s of sessions) {
    const mine = rows.filter((r) => r.source_id === s.source_id && typeof r.sdk_version === "string");
    if (mine.length > 0) s.sdk_version = mine[mine.length - 1].sdk_version;
  }

  const dbObs = dbRows({ seats: db.seats ?? [], uploads: db.uploads ?? [], requests: db.requests ?? [], sessions, episode: ep.id, tenant: ep.tenant_id }, asof_ms);
  const reportObs = reportRows((db.reports ?? []).map((r) => ({ ...r, tenant_id: ep.tenant_id, episode_id: ep.id })), asof_ms);
  const r2Obs = await r2Observations(db.uploads ?? [], { tenant: ep.tenant_id, episode: ep.id }, env);

  // Watermarks: the reads this reader made, stated honestly. db/report are complete to the read; r2 is complete only when
  // the readback actually ran (credentials present); server sources and incomplete ledgers never claim completeness.
  const watermark = (source, subject, complete) => ({ source, subject, complete_to_ms: complete ? asof_ms : null, evidence_gaps: [], emits: EMITS.get(source) ?? [], build: `${source} reader` });
  const r2Read = (db.uploads ?? []).every((u) => u.state !== "stored") || r2Obs.length > 0;
  const clientWatermarks = declaration.seats.map((seat) => {
    const mine = sessions.filter((s) => s.participant_id === seat.participant);
    const closed = mine.length > 0 && mine.every((s) => s.end_state === "closed");
    const last = Math.max(0, ...mine.map((s) => ms(s.last_received_at) ?? 0));
    return { source: "client", subject: `pt_${seat.participant}`, complete_to_ms: closed ? last : null, evidence_gaps: [], emits: EMITS.get("client") ?? [], build: "client ledger" };
  });
  const evidence = {
    observations: [...kernelObs, ...dbObs, ...reportObs, ...r2Obs],
    watermarks: [...clientWatermarks, watermark("api", ITEM, false), watermark("sync", ITEM, false), watermark("db", ITEM, true), watermark("report", ITEM, true), watermark("r2", ITEM, r2Read)],
  };
  const world = {
    declaration,
    declarations: [declaration],
    evidence: { [ep.id]: evidence },
    history: [{ item: ep.id, asof_ms, evidence }],
    sessions: sessions.map((s) => ({ id: s.source_id, meaning: "client_session", episode: ep.id, participant: s.participant_id })),
    people: [],
  };
  return { world, notes: dropped.map((d) => `dropped ${d.index} ${d.event}: ${d.why}`) };
}
