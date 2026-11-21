// @ts-check
// Coverage-completion evidence for the slice-10 recording fixture chains.
//
// The fault scenarios capture their worlds from a real isolated Postgres (scripts/recording-pipeline/*.fault.test.mjs);
// `items` declares the job under test for each run. A few declared fields appear on no single real row a world can carry:
//
//   - `recording_lease_expiry_ms` exists only while a job sits leased; a terminal, succeeded or pending job's row cannot
//     carry it (the lease columns are constrained to the leased state).
//   - `recording_probe_duration_ms` is stamped only by an r2 readback that reached ffprobe; a not_found or
//     checksum_mismatch readback cannot carry it.
//   - `recording_completed_ms`/`recording_failed_ms`/`recording_error_code` and `recording_committed_ms` depend on a
//     state no single Recording or pipeline row holds at once.
//   - `recording.claim`'s events exist only once a job is claimed; a capture that never claimed (stopped_before_claim)
//     produces neither row by definition.
//
// `synthetic` holds minimal registry-valid rows for those fields. Every one names minted (hash-derived) ids, so it binds
// to no declared subject and a check can never read it as the item's own evidence; `synthetic` on the observation marks
// it for review. Real witness rows always come first; synthetics only fill what the shape forbids.
import { createHash } from "node:crypto";

/** A deterministic uuid-shaped id from a seed, so synthetic rows never collide with captured event ids. */
const mint = (seed) => {
  const hex = createHash("sha256").update(`recording coverage|${seed}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The minted items every synthetic row claims, so it can never bind to a declared subject. */
const OTHER_JOB = mint("job");
const OTHER_EPISODE = mint("episode");
const OTHER_RECORDING = mint("recording");
const OTHER_TENANT = mint("tenant");
const OTHER_SPACE = mint("space");

/** The seeded ids the fault scenarios use — the declarations' shared spine. */
export const T = "11111111-1111-4111-8111-111111111111";
export const S = "22222222-2222-4222-8222-222222222222";
export const E = "33333333-3333-4333-8333-333333333333";
export const R = "44444444-4444-4444-8444-444444444444";
export const JOB = "77777777-7777-4777-8777-777777777777";
export const T0 = Date.parse("2026-03-01T12:00:00Z");
const ASOF = T0 + 86400000;

/** @param {"capture" | "render"} job_kind @param {number} to_ms */
const declaration = (job_kind, to_ms) => ({
  kind: "job",
  id: JOB,
  tenant: T,
  space: S,
  episode: E,
  recording: R,
  job_kind,
  window: { from_ms: T0, to_ms },
});

const run = (job_kind, to_ms) => ({ id: JOB, declaration: declaration(job_kind, to_ms), asof_ms: ASOF });

export default {
  items: {
    "recording.capture_failed": { positive: run("capture", T0 + 600000), healthy: run("capture", T0 + 600000) },
    "recording.empty": { positive: run("capture", T0 + 600000), healthy: run("capture", T0 + 600000) },
    "recording.missing_span": { positive: run("capture", T0 + 600000), healthy: run("capture", T0 + 600000) },
    "recording.never_captured": { positive: run("capture", T0 + 600000), healthy: run("capture", T0 + 600000) },
    "recording.stuck": { positive: run("capture", T0 + 600000), healthy: run("capture", T0 + 600000) },
    "render.failed": { positive: run("render", T0 + 900000), healthy: run("render", T0 + 900000) },
    "recording.artifact_unreadable": { positive: run("render", T0 + 900000), healthy: run("render", T0 + 900000) },
    "playback.url_expired": { positive: run("render", T0 + 900000), healthy: run("render", T0 + 900000) },
    "playback.decode_failed": { positive: run("render", T0 + 900000), healthy: run("render", T0 + 900000) },
    "recording.not_ready": { positive: run("render", T0 + 900000), healthy: run("render", T0 + 900000) },
  },

  needs: {
    "recording.capture_failed": { sweep: [], synthetic: ["db.job.leased", "db.pipeline.committed"] },
    "recording.empty": { sweep: [], synthetic: ["db.job.leased", "db.pipeline.committed"] },
    "recording.missing_span": { sweep: [], synthetic: ["db.job.terminal", "db.pipeline.full"] },
    "recording.never_captured": { sweep: [], synthetic: ["db.job.full", "db.journey.claimed", "db.journey.failed", "api.capture_claim", "db.pipeline.full", "db.recording.full", "db.recording.failed", "api.fleet_failed", "sfu.session_closed"] },
    "recording.stuck": { sweep: [], synthetic: ["db.job.full", "db.pipeline.full"] },
    "render.failed": { sweep: [], synthetic: ["db.job.leased"] },
    "recording.artifact_unreadable": { sweep: [], synthetic: ["db.job.full", "r2.readback.probed", "db.recording.failed"] },
    "playback.url_expired": { sweep: [], synthetic: ["db.job.full"] },
    "playback.decode_failed": { sweep: [], synthetic: ["db.job.full"] },
    "recording.not_ready": { sweep: [], synthetic: ["db.job.leased"] },
  },

  sweep: {},

  synthetic: {
    /** A leased job row: lease expiry only exists in this state, which no fault world carries. */
    "db.job.leased": {
      fact: "recording.job_state",
      source: "db",
      claim: "leased",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        job_id: OTHER_JOB,
        recording_id: OTHER_RECORDING,
        recording_job_state: "leased",
        recording_job_kind: "capture",
        recording_attempt_count: 1,
        recording_attempt_limit: 4,
        recording_available_ms: "asof",
        recording_lease_expiry_ms: "asof",
        recording_created_ms: "asof",
        recording_updated_ms: "asof",
      },
    },
    /** A terminal job row: error code and terminal time on one row, which no leased or pending world carries. */
    "db.job.terminal": {
      fact: "recording.job_state",
      source: "db",
      claim: "terminal_failure",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        job_id: OTHER_JOB,
        recording_id: OTHER_RECORDING,
        recording_job_state: "terminal_failure",
        recording_job_kind: "capture",
        recording_error_code: "media_io",
        recording_attempt_count: 4,
        recording_attempt_limit: 4,
        recording_available_ms: "asof",
        recording_created_ms: "asof",
        recording_updated_ms: "asof",
        recording_terminal_ms: "asof",
      },
    },
    /** A job row carrying every declared field, for symptoms whose positive world is a render job. */
    "db.job.full": {
      fact: "recording.job_state",
      source: "db",
      claim: "terminal_failure",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        job_id: OTHER_JOB,
        recording_id: OTHER_RECORDING,
        recording_job_state: "terminal_failure",
        recording_job_kind: "render",
        recording_error_code: "render_probe",
        recording_attempt_count: 4,
        recording_attempt_limit: 4,
        recording_available_ms: "asof",
        recording_lease_expiry_ms: "asof",
        recording_created_ms: "asof",
        recording_updated_ms: "asof",
        recording_terminal_ms: "asof",
      },
    },
    /** A claimed journey row: a never-claimed capture produces none by definition. */
    "db.journey.claimed": {
      fact: "recording.claim",
      source: "db",
      claim: "recording.claimed",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        job_id: OTHER_JOB,
        recording_id: OTHER_RECORDING,
        journey_name: "recording.claimed",
        recording_claim_lag_ms: 5000,
        recording_placement: "colocated",
        recording_created_ms: "asof",
      },
    },
    /** An api claim row: the job-scoped claim event a never-claimed capture never emits. */
    "api.capture_claim": {
      fact: "recording.claim",
      source: "api",
      claim: "1",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        job_id: OTHER_JOB,
        recording_id: OTHER_RECORDING,
        recording_attempt_count: 1,
        recording_claim_lag_ms: 5000,
        recording_placement: "colocated",
      },
    },
    /** A committed pipeline row: the commit stamp an uncommitted capture world cannot carry. */
    "db.pipeline.committed": {
      fact: "recording.pipeline",
      source: "db",
      claim: "committed",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        recording_id: OTHER_RECORDING,
        recording_pipeline_state: "committed",
        recording_committed_ms: "asof",
        recording_created_ms: "asof",
        recording_updated_ms: "asof",
      },
    },
    /** A pipeline row with every declared field, for the never-captured world whose pipeline never moved. */
    "db.pipeline.full": {
      fact: "recording.pipeline",
      source: "db",
      claim: "committed",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        recording_id: OTHER_RECORDING,
        recording_pipeline_state: "committed",
        recording_stop_requested_ms: "asof",
        recording_capture_completed_ms: "asof",
        recording_committed_ms: "asof",
        recording_media_bundles: 3,
        recording_gap_bundles: 0,
        capture_track_count: 2,
        capture_packet_count: 1200,
        recording_capture_completeness: "complete",
        recording_created_ms: "asof",
        recording_updated_ms: "asof",
      },
    },
    /** A failed journey row: failure fields a claimed journey row cannot carry. */
    "db.journey.failed": {
      fact: "recording.claim",
      source: "db",
      claim: "recording.failed",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        job_id: OTHER_JOB,
        recording_id: OTHER_RECORDING,
        journey_name: "recording.failed",
        recording_error_code: "media_io",
        recording_capture_outcome: "failed",
        recording_created_ms: "asof",
      },
    },
    /** A completed Recording row: size and duration fields a bare row cannot carry. */
    "db.recording.full": {
      fact: "recording.row",
      source: "db",
      claim: "completed",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        recording_id: OTHER_RECORDING,
        recording_exists: true,
        recording_state: "completed",
        recording_artifact_set: true,
        recording_size_bytes: 53734,
        recording_sha_set: true,
        recording_duration_ms: 2000,
        recording_created_ms: "asof",
        recording_completed_ms: "asof",
      },
    },
    /** A fleet operation failure: the fleet journal line only a fleet-placed claim attempt emits. */
    "api.fleet_failed": {
      fact: "recording.fleet",
      source: "api",
      claim: "claim",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        job_id: OTHER_JOB,
        recording_id: OTHER_RECORDING,
        recording_fleet_operation: "claim",
        recording_error_code: "fleet_unavailable",
      },
    },
    /** A closed capture session: a capture that never started has no session to close. */
    "sfu.session_closed": {
      fact: "recording.session_close",
      source: "sfu",
      claim: "completed",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        session_kind: "capture",
        participant_id: "cap-other",
        media_connection_id: "mc-cap-other",
        generation: 1,
        recording_session_outcome: "completed",
        recording_session_cause: "done",
        duration_ms: 1000,
      },
    },
    /** A failed Recording row: failure fields a processing or completed row cannot carry. */
    "db.recording.failed": {
      fact: "recording.row",
      source: "db",
      claim: "failed",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        recording_id: OTHER_RECORDING,
        recording_exists: true,
        recording_state: "failed",
        recording_error_code: "capture_lost",
        recording_artifact_set: false,
        recording_created_ms: "asof",
        recording_failed_ms: "asof",
      },
    },
    /** A probed readback row: the probe stamp a not_found or mismatched readback cannot carry. */
    "r2.readback.probed": {
      fact: "recording.object",
      source: "r2",
      claim: "ok",
      subject: { job: OTHER_JOB, episode: OTHER_EPISODE, tenant: OTHER_TENANT },
      at: "asof",
      synthetic: true,
      value: {
        recording_id: OTHER_RECORDING,
        recording_r2_result: "ok",
        recording_size_bytes: 53734,
        recording_sha_match: true,
        recording_probe_duration_ms: 2000,
      },
    },
  },
};
