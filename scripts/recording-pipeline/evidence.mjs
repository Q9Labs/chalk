// @ts-check
/**
 * The slice-10 recording evidence reader: real rows from an isolated Postgres (docker exec psql),
 * api.log/recorder.log/sfu journal/web log files from CHALK_DIAGNOSE_LOCAL_LOGS, and r2 readback via
 * scripts/diagnose-call/readback.mjs. Output is the world shape the diagnose proof chain replays:
 * { evidence: { [item]: { observations, watermarks } } }. Nothing sensitive is ever emitted: object
 * keys, signed URLs and credentials stay out of every row.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONTAINER = process.env.CHALK_RECORDING_PSQL_CONTAINER ?? "chalk-postgres-s10";
const DB = process.env.CHALK_RECORDING_PSQL_DB ?? "chalk";
const USER = process.env.CHALK_RECORDING_PSQL_USER ?? "postgres";
// When set, queries go through a local psql against this host (a socket dir or hostname) instead
// of docker exec — the same isolated-Postgres contract, for hosts where Postgres runs natively.
const HOST = process.env.CHALK_RECORDING_PSQL_HOST;
const logsDir = () => process.env.CHALK_DIAGNOSE_LOCAL_LOGS ?? ".logs/diagnose";

const ms = (v) => (v === null || v === undefined ? null : new Date(v).getTime());

/** Run one read-only query, returning parsed row objects. */
export function psql(sql) {
  const q = `select coalesce(json_agg(t), '[]'::json) from (${sql}) t`;
  const out = HOST
    ? execFileSync("psql", ["-h", HOST, "-U", USER, "-d", DB, "-At", "-c", q], { encoding: "utf8", maxBuffer: 64 << 20 })
    : execFileSync("docker", ["exec", CONTAINER, "psql", "-U", USER, "-d", DB, "-At", "-c", q], { encoding: "utf8", maxBuffer: 64 << 20 });
  return JSON.parse(out.trim() || "[]");
}

const row = (event, est, fields) => ({ event, est_server_ms: est, ...fields });

/** The db evidence rows for one capture or render job (kind 'capture'|'render'). */
export function dbRowsForJob(jobId) {
  const rows = [];
  const [job] = psql(`select * from recording_jobs where id = '${jobId}'`);
  if (!job) return rows;
  const rid = job.recording_id;
  rows.push(row("recording.db.job", ms(job.created_at), {
    job_id: jobId, recording_id: rid, recording_job_state: job.state, recording_job_kind: job.kind,
    recording_error_code: job.error_code ?? undefined, recording_attempt_count: job.attempt_count, recording_attempt_limit: job.attempt_limit,
    recording_available_ms: ms(job.available_at), recording_lease_expiry_ms: ms(job.lease_expires_at) ?? undefined,
    recording_created_ms: ms(job.created_at), recording_updated_ms: ms(job.updated_at), recording_terminal_ms: ms(job.terminal_at) ?? undefined,
  }));
  const [p] = psql(`select * from recording_pipelines where recording_id = '${rid}'`);
  if (p) rows.push(row("recording.db.pipeline", ms(p.created_at), {
    recording_id: rid, recording_pipeline_state: p.state, recording_stop_requested_ms: ms(p.stop_requested_at) ?? undefined,
    recording_capture_completed_ms: ms(p.capture_completed_at) ?? undefined, recording_committed_ms: ms(p.committed_at) ?? undefined,
    recording_media_bundles: p.capture_media_bundle_count ?? undefined, recording_gap_bundles: p.capture_gap_bundle_count ?? undefined,
    capture_track_count: p.capture_track_count ?? undefined, capture_packet_count: p.capture_packet_count ?? undefined,
    recording_capture_completeness: p.capture_completeness ?? undefined, recording_created_ms: ms(p.created_at), recording_updated_ms: ms(p.updated_at),
  }));
  const [rec] = psql(`select * from recordings where id = '${rid}'`);
  rows.push(row("recording.db.recording", ms(rec?.created_at) ?? 0, {
    recording_id: rid, recording_exists: !!rec, recording_state: rec?.status, recording_error_code: rec?.failure_code ?? undefined,
    recording_artifact_set: rec ? rec.storage_key !== null : undefined, recording_size_bytes: rec?.storage_size ?? undefined,
    recording_sha_set: rec ? rec.storage_checksum !== null : undefined, recording_duration_ms: rec?.duration_millis ?? undefined,
    recording_created_ms: rec ? ms(rec.created_at) : undefined, recording_completed_ms: rec ? ms(rec.completed_at) : undefined, recording_failed_ms: rec ? ms(rec.failed_at) : undefined,
  }));
  const [res] = psql(`select * from recording_reservations where recording_id = '${rid}'`);
  if (res) rows.push(row("recording.db.reservation", ms(res.created_at), {
    recording_id: rid, recording_reservation_state: res.state, recording_reservation_starts_ms: ms(res.starts_at) ?? undefined,
    recording_reservation_ends_ms: ms(res.ends_at), recording_created_ms: ms(res.created_at),
  }));
  for (const j of psql(`select * from observability_journey_events where name in ('recording.claimed','recording.capture.salvaged','recording.failed') and attributes->>'recording_id' = '${rid}'`)) {
    const a = j.attributes ?? {};
    rows.push(row("recording.db.journey", ms(j.occurred_at), {
      recording_id: rid, job_id: a.job_id ?? jobId, journey_name: j.name, recording_claim_lag_ms: a.claim_lag_ms ?? undefined,
      recording_placement: a.placement ?? undefined, recording_error_code: a.error_code ?? a.failure_code ?? undefined,
      recording_capture_outcome: a.capture_outcome ?? undefined, recording_created_ms: ms(j.occurred_at),
    }));
  }
  for (const f of psql(`select * from recording_job_attempt_failures where job_id = '${jobId}'`)) {
    rows.push(row("recording.db.attempt", ms(f.failed_at), {
      job_id: jobId, recording_id: rid, recording_attempt: f.attempt_count, recording_job_kind: f.kind,
      recording_error_code: f.error_code, recording_failed_ms: ms(f.failed_at),
    }));
  }
  const [art] = psql(`select * from recording_artifacts where recording_id = '${rid}'`);
  rows.push(row("recording.db.artifact", ms(art?.committed_at) ?? ms(job.created_at), {
    recording_id: rid, recording_artifact_set: !!art,
    recording_size_bytes: art?.byte_size ?? undefined, recording_sha_set: art ? art.checksum !== null : undefined,
    recording_storage_match: art && rec ? art.object_key === rec.storage_key : undefined,
    recording_duration_ms: art?.duration_millis ?? undefined, recording_expires_ms: art ? ms(art.expires_at) : undefined,
    recording_committed_ms: art ? ms(art.committed_at) : undefined,
  }));
  const [ep] = psql(`select ended_at, config_snapshot from episodes where id = '${job.episode_id}'`);
  if (ep) rows.push(row("recording.db.episode", ms(job.created_at), {
    recording_id: rid, recording_episode_ended_ms: ms(ep.ended_at) ?? undefined,
    recording_media_plane: ep.config_snapshot?.media_plane ?? ep.config_snapshot?.media?.plane ?? undefined,
  }));
  const [sr] = psql(`select * from sync_recordings where recording_id = '${rid}'`);
  if (sr) rows.push(row("recording.db.sync_recording", ms(sr.created_at), {
    recording_id: rid, recording_sync_status: sr.status, recording_created_ms: ms(sr.created_at),
  }));
  for (const b of psql(`select * from recording_bundles where recording_id = '${rid}' order by sequence_number`)) {
    rows.push(row("recording.db.bundle", ms(b.created_at), { recording_id: rid, recording_bundle_sequence: b.sequence_number, recording_size_bytes: b.byte_size }));
  }
  return rows;
}

/** The bundle object keys for r2 bundle-head reads (keys themselves are never emitted). */
export function bundleKeys(recordingId) {
  return psql(`select sequence_number, object_key from recording_bundles where recording_id = '${recordingId}' order by sequence_number`).map((r) => ({ seq: r.sequence_number, key: r.object_key }));
}
/** The committed object key for the artifact readback (never emitted). */
export function artifactKey(recordingId) {
  const [a] = psql(`select object_key from recording_artifacts where recording_id = '${recordingId}'`);
  return a?.object_key ?? null;
}

/** Read a JSON-lines log file into raw rows; missing file means the source was not read. */
export function logRows(name) {
  const path = join(logsDir(), name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export default { dbRowsForJob, bundleKeys, artifactKey, logRows, psql };
