// @ts-check
/**
 * Shared fault-scenario harness for slice 10: seeds the full FK chain into the isolated
 * recording Postgres (chalk-postgres-s10, never production), reads the real rows through
 * evidence.mjs, and hands them to the symptom's decide(). Deterministic: every clock is fixed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { psql, dbRowsForJob, logRows, artifactKey } from "./evidence.mjs";
import { artifactReadback } from "../diagnose-call/readback.mjs";
import { chainFiles, coverageRows, itemRows, writeOrCompareRows } from "./fixture-rows.helper.mjs";
import coverage from "./chain-inputs/recording.coverage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const C = () => process.env.CHALK_RECORDING_PSQL_CONTAINER ?? "chalk-postgres-s10";
const D = () => process.env.CHALK_RECORDING_PSQL_DB ?? "chalk";
const U = () => process.env.CHALK_RECORDING_PSQL_USER ?? "postgres";
// CHALK_RECORDING_PSQL_HOST switches the whole harness from docker exec to a local psql — the
// same isolated-Postgres contract for hosts where Postgres runs natively (a socket dir or host).
const H = () => process.env.CHALK_RECORDING_PSQL_HOST;
const sql = (q) => H()
  ? execFileSync("psql", ["-h", H(), "-U", U(), "-d", D(), "-q", "-c", q], { stdio: "pipe" })
  : execFileSync("docker", ["exec", C(), "psql", "-U", U(), "-d", D(), "-q", "-c", q], { stdio: "pipe" });

export const T = "11111111-1111-4111-8111-111111111111";
export const S = "22222222-2222-4222-8222-222222222222";
export const E = "33333333-3333-4333-8333-333333333333";
export const R = "44444444-4444-4444-8444-444444444444";
export const RES = "55555555-5555-4555-8555-555555555555";
export const OP = "66666666-6666-4666-8666-666666666666";
export const T0 = Date.parse("2026-03-01T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

/** True when the isolated Postgres is reachable. */
export function containerUp() {
  try {
    if (process.env.CHALK_RECORDING_PSQL_HOST) {
      execFileSync("psql", ["-h", process.env.CHALK_RECORDING_PSQL_HOST, "-U", U(), "-d", D(), "-Atc", "select 1"], { stdio: "pipe" });
    } else {
      execFileSync("docker", ["exec", process.env.CHALK_RECORDING_PSQL_CONTAINER ?? "chalk-postgres-s10", "psql", "-U", "postgres", "-d", "chalk", "-Atc", "select 1"], { stdio: "pipe" });
    }
    return true;
  } catch { return false; }
}

/** Seed the FK chain + one recording job and its companions; callers then mutate into the fault shape. */
export function seed(over = {}) {
  const s = sql;
  s(`delete from recording_job_attempt_failures where job_id in (select id from recording_jobs where tenant_id='${T}');
     delete from observability_journey_events where attributes->>'recording_id' in (select id::text from recordings where tenant_id='${T}');
     delete from recording_artifacts where tenant_id='${T}'; delete from recording_bundles where tenant_id='${T}';
     delete from recording_jobs where tenant_id='${T}'; delete from recording_pipelines where tenant_id='${T}';
     delete from recording_reservations where tenant_id='${T}'; delete from sync_recordings where tenant_id='${T}';
     delete from recordings where tenant_id='${T}'; delete from sync_external_operations where tenant_id='${T}';
     delete from sync_episode_control where tenant_id='${T}'; delete from episodes where tenant_id='${T}';
     delete from spaces where tenant_id='${T}'; delete from tenants where id='${T}'`);
  s(`insert into tenants(id,name) values('${T}','t') on conflict do nothing`);
  s(`insert into spaces(id,name,tenant_id,slug,media_plane) values('${S}','s','${T}','s','chalk_sfu') on conflict do nothing`);
  s(`insert into episodes(id,status,space_id,tenant_id,ended_at,config_snapshot) values('${E}','ended','${S}','${T}','${iso(T0 + 3600000)}','{"media_plane":"chalk_sfu"}') on conflict do nothing`);
  s(`insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes) values('${T}','${S}','${E}','{}',1,decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),0) on conflict do nothing`);
  s(`insert into sync_external_operations(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,payload,status,completed_at) values('${T}','${S}','${E}','${OP}','k0000000000000000',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'start_recording','{}','applied','${iso(T0)}') on conflict do nothing`);
  s(`insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider,failure_code,failed_at,completed_at,created_at) values('${R}','${T}','${S}','${E}','${over.recordingStatus ?? "processing"}','r2',${over.failureCode ? `'${over.failureCode}'` : "null"},${over.failedMs ? `'${iso(over.failedMs)}'` : "null"},${over.completedMs ? `'${iso(over.completedMs)}'` : "null"},'${iso(T0)}')`);
  s(`insert into sync_recordings(tenant_id,space_id,episode_id,recording_id,status,generation,start_external_operation_id,created_at) values('${T}','${S}','${E}','${R}','${over.syncStatus ?? "recording"}',1,'${OP}','${iso(over.syncCreatedMs ?? T0)}')`);
  s(`insert into recording_reservations(id,tenant_id,space_id,episode_id,recording_id,idempotency_key,request_fingerprint,policy_snapshot_version,participant_count,max_duration_seconds,input_bitrate_bps,state,starts_at,ends_at,created_at) values('${RES}','${T}','${S}','${E}','${R}','k',decode('${'00'.repeat(32)}','hex'),'episode_config.v2',2,3600,2000000,'${over.reservationState ?? "released"}',${over.reservationStartsMs ? `'${iso(over.reservationStartsMs)}'` : "null"},'${iso(T0 + 3600000)}','${iso(T0)}')`);
  s(`insert into recording_pipelines(recording_id,tenant_id,reservation_id,state,capture_media_bundle_count,capture_gap_bundle_count,capture_completeness,capture_track_count,capture_packet_count,stop_operation_id,stop_requested_at,capture_completed_at,committed_at,created_at,updated_at) values('${R}','${T}','${RES}','${over.pipelineState ?? "reserved"}',${over.mediaBundles ?? "null"},${over.gapBundles ?? "null"},${over.completeness ? `'${over.completeness}'` : "null"},${over.trackCount ?? "null"},${over.packetCount ?? "null"},${over.stopRequestedMs ? `'${OP}'` : "null"},${over.stopRequestedMs ? `'${iso(over.stopRequestedMs)}'` : "null"},${over.captureCompletedMs ? `'${iso(over.captureCompletedMs)}'` : "null"},${over.committedMs ? `'${iso(over.committedMs)}'` : "null"},'${iso(T0)}','${iso(over.pipelineUpdatedMs ?? T0 + 60000)}')`);
  const jobId = over.jobId ?? "77777777-7777-4777-8777-777777777777";
  const leased = (over.jobState ?? "pending") === "leased";
  s(`insert into recording_jobs(id,tenant_id,episode_id,recording_id,kind,idempotency_key,payload_schema_version,state,available_at,attempt_count,attempt_limit,error_code,terminal_at,lease_token,lease_owner,lease_expires_at,created_at,updated_at) values('${jobId}','${T}','${E}','${R}','${over.kind ?? "capture"}','${jobId}',1,'${over.jobState ?? "pending"}','${iso(over.availableMs ?? T0)}',${over.attemptCount ?? 0},${over.attemptLimit ?? 4},${over.errorCode ? `'${over.errorCode}'` : "null"},${over.terminalMs ? `'${iso(over.terminalMs)}'` : "null"},${leased ? `'${jobId}-lease','w','${iso(over.leaseExpiresMs ?? T0 + 120000)}'` : "null,null,null"},'${iso(T0)}','${iso(over.jobUpdatedMs ?? T0 + 60000)}')`);
  if (over.claimLagMs !== undefined) {
    s(`insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility,attributes) values(gen_random_uuid(),'${R}',0,'${iso(T0 + (over.claimLagMs ?? 0))}','recording.claimed','capture_claim','succeeded','server','api','visible','{"recording_id":"${R}","job_id":"${jobId}","claim_lag_ms":${over.claimLagMs ?? 0},"placement":"${over.placement ?? "colocated"}"}')`);
  }
  for (const j of over.journeyEvents ?? []) {
    s(`insert into observability_journey_events(event_id,journey_id,sequence,occurred_at,name,phase,state,origin_kind,first_observed_layer,upstream_visibility,attributes) values(gen_random_uuid(),'${R}',${j.sequence ?? 1},'${iso(j.at ?? T0)}','${j.name}','${j.phase ?? "capture_complete"}','${j.state ?? "failed"}','${j.originKind ?? "server"}','${j.firstLayer ?? "recorder"}','visible','${JSON.stringify({ recording_id: R, job_id: jobId, ...(j.attributes ?? {}) }).replace(/'/g, "''")}')`);
  }
  for (const f of over.failures ?? []) {
    s(`insert into recording_job_attempt_failures(job_id,attempt_count,fencing_generation,kind,error_code,error_detail,lease_owner,failed_at) values('${jobId}',${f.attempt},1,'${over.kind ?? "capture"}','${f.code}','d','w','${iso(f.at)}')`);
  }
  if (over.artifact) {
    const a = over.artifact;
    s(`insert into recording_artifacts(recording_id,tenant_id,render_job_id,object_key,content_type,byte_size,checksum,duration_millis,committed_at,expires_at) values('${R}','${T}','${jobId}','${a.key ?? "obj/k"}','video/mp4',${a.size ?? 1000},decode('${a.sha ?? "00".repeat(16)}','hex'),${a.duration ?? 30000},'${iso(a.committedMs ?? T0 + 120000)}','${iso(a.expiresMs ?? T0 + 120000 + 90 * 86400000)}')`);
    if (a.complete) s(`update recordings set status='completed',storage_key='${a.key ?? "obj/k"}',storage_size=${a.size ?? 1000},storage_checksum=decode('${a.sha ?? "00".repeat(16)}','hex'),duration_millis=${a.duration ?? 30000},completed_at='${iso(a.committedMs ?? T0 + 120000)}' where id='${R}'`);
  }
  return { jobId, recordingId: R, episodeId: E, tenant: T };
}

/**
 * An isolated evidence world: `logs` is {name: [rows]} written as JSON-lines under a fresh
 * CHALK_DIAGNOSE_LOCAL_LOGS dir, `objects` is {key: bytes-or-mp4} written under CHALK_DIAGNOSE_R2_DIR
 * ({mp4: {seconds}} generates a real file with ffmpeg). The emitter and readback readers then see
 * exactly what they would in a live read. Returns the world's dirs for inspection.
 */
export function world({ logs = {}, objects = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chalk-s10-"));
  const logsDirPath = join(root, "logs");
  const r2Dir = join(root, "r2");
  mkdirSync(logsDirPath, { recursive: true });
  mkdirSync(r2Dir, { recursive: true });
  for (const [name, rows] of Object.entries(logs)) {
    writeFileSync(join(logsDirPath, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  for (const [key, spec] of Object.entries(objects)) {
    const path = join(r2Dir, key);
    mkdirSync(join(path, ".."), { recursive: true });
    if (spec?.mp4) {
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=duration=${spec.mp4.seconds ?? 2}:size=320x240:rate=15`, "-pix_fmt", "yuv420p", "-f", "mp4", path]);
    } else {
      writeFileSync(path, spec?.bytes ?? Buffer.from("object-bytes"));
    }
  }
  process.env.CHALK_DIAGNOSE_LOCAL_LOGS = logsDirPath;
  process.env.CHALK_DIAGNOSE_R2_DIR = r2Dir;
  return { logsDir: logsDirPath, r2Dir };
}

/** Commit the db account for an object that really sits in the world's r2 dir: real size, sha and duration. Artifacts are update-immutable, so the row is rewritten. */
export function commitObject(recordingId, jobId, key, r2Dir) {
  const path = join(r2Dir, key);
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", path], { encoding: "utf8" }));
  const durMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
  sql(`delete from recording_artifacts where recording_id='${recordingId}'`);
  sql(`insert into recording_artifacts(recording_id,tenant_id,render_job_id,object_key,content_type,byte_size,checksum,duration_millis,committed_at) values('${recordingId}','${T}','${jobId}','${key}','video/mp4',${bytes.length},decode('${sha}','hex'),${durMs},'${iso(T0 + 120000)}')`);
  sql(`update recordings set storage_key='${key}',storage_size=${bytes.length},storage_checksum=decode('${sha}','hex'),duration_millis=${durMs} where id='${recordingId}'`);
  return { size: bytes.length, sha, durMs };
}

/** The r2 readback rows for a committed Recording: real HEAD/probe/decode against the world's objects. */
export function readbackRows(recordingId, jobId, at = T0 + 700000) {
  const [art] = psql(`select * from recording_artifacts where recording_id = '${recordingId}'`);
  if (!art) return [];
  const key = artifactKey(recordingId);
  const expected = {
    byte_size: art.byte_size ?? undefined,
    checksum_hex: art.checksum ? String(art.checksum).replace(/^\\x/, "") : undefined,
    duration_millis: art.duration_millis ?? undefined,
  };
  return [artifactReadback(recordingId, key, expected, at)];
}

/** Emitter rows the fault worlds write into the local-log evidence source, one helper per event. */
export const rows = {
  sfuSession: (kind, id, at) => ({ event: "sfu.session.registered", session_kind: kind, participant_id: id, media_connection_id: `mc-${id}`, generation: 1, est_server_ms: at }),
  sfuClosed: (kind, id, outcome, at) => ({ event: "sfu.session.closed", session_kind: kind, participant_id: id, media_connection_id: `mc-${id}`, generation: 1, recording_session_outcome: outcome, recording_session_cause: outcome === "completed" ? "done" : "error", est_server_ms: at }),
  sfuPublication: (id, source, kind, at) => ({ event: "sfu.publication.started", session_kind: "participant", participant_id: id, generation: 1, recording_media_source: source, recording_media_kind: kind, est_server_ms: at }),
  sfuIngress: (id, kind, packets, final, at) => ({ event: "sfu.media.ingress", session_kind: "participant", participant_id: id, recording_media_source: "camera", recording_media_kind: kind, recording_packets: packets, recording_final: final, est_server_ms: at }),
  sfuTransport: (id, audio, video, final, at) => ({ event: "sfu.media.transport", session_kind: "capture", participant_id: id, recording_sent_audio: audio, recording_sent_video: video, recording_final: final, est_server_ms: at }),
  captureAttempt: (attempt, packets, tracks, cause, at) => ({ event: "recording.capture_attempt", recording_attempt_count: attempt, recording_attempt_limit: 4, capture_packet_count: packets, capture_track_count: tracks, stop_cause: cause, est_server_ms: at }),
  captureFinished: (outcome, packets, tracks, cause, at) => ({ event: "recording.capture_finished", recording_capture_outcome: outcome, capture_packet_count: packets, capture_track_count: tracks, stop_cause: cause, est_server_ms: at }),
  apiClaim: (attempt, lag, placement, at) => ({ event: "recording.capture_claim", recording_attempt_count: attempt, recording_claim_lag_ms: lag, recording_placement: placement, est_server_ms: at }),
  apiAttemptFailed: (kind, attempt, code, detail, at) => ({ event: kind === "render" ? "recording.render_attempt_failed" : "recording.capture_attempt_failed", recording_attempt_count: attempt, recording_error_code: code, recording_error_detail: detail, est_server_ms: at }),
  renderStage: (stage, at) => ({ event: "recording.render_stage", recording_stage: stage, est_server_ms: at }),
  mint: (signed, lifetime, at) => ({ event: "playback.url_minted", recording_id: R, playback_signed_ms: signed, playback_expires_ms: signed + lifetime, url_lifetime_ms: lifetime, playback_download: true, mint_count: 1, est_server_ms: at }),
  mediaError: (code, age, lifetime, at) => ({ event: "playback.media_error", recording_id: R, player_id: "pl1", media_error_code: code, url_age_ms: age, url_lifetime_ms: lifetime, mint_count: 1, can_play_mp4: "probably", est_server_ms: at }),
  playerErrorNote: (id, at) => ({ event: "playback.player_error_note", player_id: id, est_server_ms: at }),
  mediaPublish: (action, outcome, at) => ({ event: "recording.media_publish", participant_id: "p1", recording_media_action: action, recording_media_outcome: outcome, est_server_ms: at }),
  bundleHead: (seq, result, at) => ({ event: "recording.r2.bundle_head", recording_id: R, recording_bundle_sequence: seq, recording_head_result: result, est_server_ms: at }),
  progressed: (at) => ({ event: "playback.progressed", recording_id: R, player_id: "pl1", playback_progress_ms: 1500, url_age_ms: 30000, url_lifetime_ms: 3600000, mint_count: 1, est_server_ms: at }),
};

/** The healthy capture world: claimed inside the bound, media committed, every source reporting. */
export function healthyCapture() {
  const seeded = seed({
    jobState: "succeeded", attemptCount: 1, terminalMs: T0 + 600000, claimLagMs: 5000, reservationStartsMs: T0,
    recordingStatus: "completed", completedMs: T0 + 620000,
    pipelineState: "committed", mediaBundles: 3, gapBundles: 0, completeness: "complete", trackCount: 2, packetCount: 1200,
    stopRequestedMs: T0 + 540000, captureCompletedMs: T0 + 560000, committedMs: T0 + 620000,
  });
  const dirs = world({
    logs: {
      "api.log": [rows.apiClaim(1, 5000, "colocated", T0 + 5000)],
      "sfu.log": [
        rows.sfuSession("participant", "p1", T0 + 60000), rows.sfuSession("capture", "cap1", T0 + 61000),
        rows.sfuPublication("p1", "camera", "video", T0 + 62000),
        rows.sfuIngress("p1", "video", 1200, false, T0 + 100000), rows.sfuTransport("cap1", 800, 1200, false, T0 + 100000),
        rows.sfuTransport("cap1", 900, 1300, true, T0 + 540000),
        rows.sfuClosed("participant", "p1", "completed", T0 + 580000), rows.sfuClosed("capture", "cap1", "completed", T0 + 590000),
      ],
      "recorder.log": [rows.captureAttempt(1, 1200, 2, "explicit", T0 + 550000), rows.captureFinished("stopped", 1200, 2, "explicit", T0 + 560000)],
    },
  });
  return { ...seeded, ...dirs, extra: [] };
}

/** The healthy render world: committed pipeline, a real MP4 in the object dir, mint used, player progressing. */
export async function healthyRender() {
  const seeded = seed({
    kind: "render", jobState: "succeeded", attemptCount: 1, terminalMs: T0 + 900000, reservationStartsMs: T0,
    recordingStatus: "completed", completedMs: T0 + 700000, artifact: { complete: true },
    pipelineState: "committed", mediaBundles: 3, gapBundles: 0, completeness: "complete", trackCount: 2, packetCount: 1200,
    stopRequestedMs: T0 + 540000, captureCompletedMs: T0 + 560000, committedMs: T0 + 700000,
  });
  const dirs = world({
    objects: { "obj/k": { mp4: { seconds: 2 } } },
    logs: {
      "api.log": [rows.mint(T0 + 800000, 3600000, T0 + 800000)],
      "web.log": [rows.progressed(T0 + 850000)],
      "recorder.log": [rows.renderStage("probe", T0 + 700000)],
    },
  });
  commitObject(seeded.recordingId, seeded.jobId, "obj/k", dirs.r2Dir);
  const extra = readbackRows(seeded.recordingId, seeded.jobId);
  return { ...seeded, ...dirs, extra };
}

const SOURCES = ["db", "api", "sfu", "recorder", "client", "web", "r2"];

/**
 * The captured world a diagnose read produces for one job item: every db row, every local log row and
 * every r2 readback row becomes a present observation on the fact its registry event feeds, carrying
 * the observation shape the chain machinery replays (fact, source, origin, subject, window, claim,
 * value). Rows whose event maps to no fact are dropped, never guessed. `extra` appends caller-supplied
 * rows (e.g. readbacks).
 */
export async function captureWorld(jobId, { extra = [], asOf = T0 + 86400000 } = {}) {
  const rows = [
    ...dbRowsForJob(jobId),
    ...["api.log", "sfu.log", "recorder.log", "web.log", "client.log", "r2.log"].flatMap((n) => logRows(n) ?? []),
    ...extra,
  ];
  const registry = (await import("../../observability/generated/registry.json", { with: { type: "json" } })).default;
  const factOf = new Map();
  for (const fact of registry.facts) for (const ev of fact.events) factOf.set(`${ev.event}|${ev.source}`, { fact: fact.name, claim: ev.claim });
  const readings = {};
  const observations = [];
  for (const r of rows) {
    const eventName = r.event ?? r.name;
    const hit = SOURCES.map((source) => ({ source, hit: factOf.get(`${eventName}|${source}`) })).find((entry) => entry.hit);
    if (!hit) continue;
    if (r[hit.hit.claim] === undefined || r[hit.hit.claim] === null) continue; // a row without its claim field places nothing
    readings[hit.hit.fact] = readings[hit.hit.fact] ?? { kind: "present", observations: [] };
    const observation = {
      id: `${eventName}|${rows.indexOf(r)}`,
      fact: hit.hit.fact,
      source: hit.source,
      origin: `measured:${hit.source}`,
      subject: { job: jobId, tenant: T, space: S, episode: E, recording: r.recording_id ?? R },
      window: { from_ms: r.est_server_ms ?? T0, to_ms: asOf },
      claim: String(r[hit.hit.claim]),
      value: r,
      failure: false,
    };
    observations.push(observation);
    readings[hit.hit.fact].observations.push(observation);
  }
  return { readings, rows, world: { evidence: { [jobId]: { observations } }, asof_ms: asOf } };
}

/**
 * The decide() input the diagnose chain builds for one job item, from its captured world.
 * `extra` appends caller-supplied rows (e.g. readbacks).
 */
export async function decideFor(jobId, ruleModule, { extra = [], asOf = T0 + 86400000 } = {}) {
  const { readings, rows, world } = await captureWorld(jobId, { extra, asOf });
  const decision = ruleModule.decide({ readings, window: { from_ms: T0, to_ms: asOf } });
  return { decision, rows, world };
}

/**
 * Hop (a)'s hand-off: the positive run's captured world plus the healthy run's, turned into the
 * chain's row files under observability/fixtures/<code>/chain/. With CHALK_CHAIN_WRITE=1 they are
 * written; a plain run compares them, so a stale or hand-edited hand-off fails the scenario.
 * @param {string} code the symptom code
 * @param {{ world: any, item: string }} positive the positive run's captured world and item id
 * @param {{ world: any, item: string }} healthy the healthy run's captured world and item id
 */
export function handoff(code, positive, healthy) {
  const dir = join(ROOT, "observability", "fixtures", code, "chain");
  const positiveFiles = chainFiles(
    itemRows(positive.world, positive.item),
    coverageRows(code, coverage, { asof_ms: positive.world.asof_ms, tenant: T }),
    "positive",
  );
  const healthyFiles = chainFiles(itemRows(healthy.world, healthy.item), { witness: [], coverage: [] }, "healthy");
  const writes = [...positiveFiles, ...healthyFiles].map(([name]) => name);
  const hops = {
    hops: [
      {
        hop: "a",
        test: `scripts/recording-pipeline/${code}.fault.test.mjs`,
        command: `node --test scripts/recording-pipeline/${code}.fault.test.mjs`,
        writes,
      },
      {
        hop: "b",
        test: "scripts/recording-pipeline/recording-fixtures-chain.test.mjs",
        command: "node --test scripts/recording-pipeline/recording-fixtures-chain.test.mjs",
        writes: ["../positive.json", "../healthy.json"],
      },
    ],
  };
  writeOrCompareRows(dir, [...positiveFiles, ...healthyFiles, ["hops.json", hops]]);
}
