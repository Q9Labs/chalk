// Coverage-completion evidence for the transcript fixture chains.
//
// The captured worlds (transcript.<code>.<positive|healthy>.mjs) carry every row the symptom's own item emitted in the local run.
// A few declared witness fields and three whole events appear in none of them:
//
//   - `transcript.finalize_retry` never fired: no finalize job was retried in this run.
//   - `transcript_first_retry_kind`/`transcript_first_retry_code` exist only on jobs requeued after a retry; the captured jobs
//     dead-lettered or completed on one attempt.
//   - `transcript_lease_expiry_ms` is stamped only while a job sits leased; the completed/dead-letter snapshots do not carry it.
//   - `transcript.document_read` rows are emitted by the documents read path, which no capture reached with a live object.
//   - `reason_code` on claim decisions is emitted only by the claim sweep, which is not item-scoped and so was never captured
//     into a world's per-item evidence.
//
// This file holds the rows that close those gaps. Two groups:
//
//   - `sweep`: real rows copied verbatim from .logs/dev/api.log — the dispatcher's none-claim sweeps, which carry reason_code.
//     They name no job, so they bind to nothing.
//   - `synthetic`: minimal registry-valid rows written by hand for declared events and fields no captured row in this run
//     contains. Every one names minted (hash-derived) subject ids, so it binds to no declared subject and a check can never
//     read it as the item's own evidence; `synthetic` on the observation marks it for review.
import { createHash } from "node:crypto";

/** A deterministic uuid-shaped id from a seed, so synthetic rows never collide with captured event ids. */
const mint = (seed) => {
  const hex = createHash("sha256").update(`transcript coverage|${seed}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The minted item every synthetic row claims, so it can never bind to a declared subject. */
const OTHER_JOB = mint("job");
const OTHER_EPISODE = mint("episode");
const OTHER_RECORDING = mint("recording");

/**
 * Real none-claim sweep rows from .logs/dev/api.log of the captured run (the dispatcher's periodic claim pass emits one row per
 * pass; none is about an item, so no world scoped to an item carried them). Each keeps its real event_id and decision_id.
 */
const sweep = {
  claim_none: {
    id: "d325dc77-1a00-4bef-b7ed-848d7ffa193c",
    fact: "transcript.claim_decision",
    source: "api",
    origin: "decision:d3b4c016-c448-4366-91f3-a5950a034ffa",
    subject: {},
    window: { from_ms: 1795200391546, to_ms: 1795200391546 },
    claim: "none",
    value: { decision: "none", reason_code: "transcript.no_claimable_job", est_server_ms: 1795200391546 },
    borrowed_from: ".logs/dev/api.log transcript.claim none-sweep",
  },
  finalize_claim_none: {
    id: "c6ad77aa-20b6-46fb-92ec-5f25e44f6d80",
    fact: "transcript.finalize_claim_decision",
    source: "api",
    origin: "decision:cc11c811-f12d-443a-af47-8cb6e21d6d9a",
    subject: {},
    window: { from_ms: 1795200391546, to_ms: 1795200391546 },
    claim: "none",
    value: { decision: "none", reason_code: "transcript.no_claimable_job", est_server_ms: 1795200391546 },
    borrowed_from: ".logs/dev/api.log transcript.finalize_claim none-sweep",
  },
};

/**
 * Hand-written rows for declared events and fields no captured row contains. `at: "asof"` asks the converter to stamp
 * est_server_ms and the observation window at the fixture's as-of time. Every synthetic observation carries
 * `synthetic: true`.
 */
const synthetic = {
  /** A dead-lettered chunk job row carrying every declared db.job field: lease expiry and first-retry attribution included. */
  "db.job.full": {
    fact: "transcript.job_state",
    source: "db",
    claim: "dead_letter",
    subject: { job: OTHER_JOB, episode: OTHER_EPISODE },
    at: "asof",
    synthetic: true,
    value: {
      job_id: OTHER_JOB,
      transcript_job_state: "dead_letter",
      transcript_job_kind: "transcription_chunk",
      transcript_error_code: "provider_rejected",
      transcript_attempt_count: 2,
      transcript_attempt_limit: 4,
      transcript_terminal_ms: "asof",
      transcript_available_ms: "asof",
      transcript_lease_expiry_ms: "asof",
      transcript_created_ms: "asof",
      transcript_updated_ms: "asof",
      transcript_latest_job: true,
      transcript_open_jobs: 0,
      transcript_dead_letter_jobs: 1,
      transcript_first_retry_kind: "transcription_chunk",
      transcript_first_retry_code: "provider_rejected",
      est_server_ms: "asof",
    },
  },
  /** A retryable attempt row carrying transcript_error_code, the one declared db.attempt field the accepted attempts lack. */
  "db.attempt.retryable": {
    fact: "transcript.attempts",
    source: "db",
    claim: "retryable_failure",
    subject: { job: OTHER_JOB, episode: OTHER_EPISODE },
    at: "asof",
    synthetic: true,
    value: {
      transcript_attempt_state: "retryable_failure",
      attempt: 2,
      transcript_generation: 1,
      transcript_error_code: "provider_timeout",
      transcript_provider: "openrouter",
      transcript_observed_ms: 2300,
      transcript_finished_ms: "asof",
      transcript_chunk_index: 0,
      transcript_speech_ms: 2300,
      est_server_ms: "asof",
    },
  },
  /** A leased prep row carrying transcript_lease_expiry_ms, which no captured prep snapshot kept. */
  "db.prep.leased": {
    fact: "transcript.prep",
    source: "db",
    claim: "leased",
    subject: { job: OTHER_JOB, episode: OTHER_EPISODE },
    at: "asof",
    synthetic: true,
    value: {
      recording_id: OTHER_RECORDING,
      transcript_exists: true,
      transcript_prep_state: "leased",
      transcript_error_code: "transcription_prepare_failed",
      transcript_attempt_count: 1,
      transcript_available_ms: "asof",
      transcript_terminal_ms: "asof",
      transcript_lease_expiry_ms: "asof",
      est_server_ms: "asof",
    },
  },
  /** A succeeded render job row carrying every declared db.render field; the captured `none` claims carry only job_id and state. */
  "db.render.succeeded": {
    fact: "transcript.render",
    source: "db",
    claim: "succeeded",
    subject: { job: OTHER_JOB, episode: OTHER_EPISODE },
    at: "asof",
    synthetic: true,
    value: {
      job_id: OTHER_JOB,
      transcript_prep_state: "succeeded",
      transcript_terminal_ms: "asof",
      transcript_available_ms: "asof",
      transcript_created_ms: "asof",
      est_server_ms: "asof",
    },
  },
  /** A retryable job-retry decision carrying reason_code, which the captured dead_letter decision does not emit. */
  "job_retry.retryable": {
    fact: "transcript.retry_decision",
    source: "api",
    claim: "retryable",
    subject: { job: OTHER_JOB },
    at: "asof",
    synthetic: true,
    value: {
      job_id: OTHER_JOB,
      attempt: 2,
      transcript_error_code: "provider_timeout",
      decision: "retryable",
      reason_code: "transcript.late_completion",
      est_server_ms: "asof",
    },
  },
  /** A rejected completion decision carrying reason_code, which the captured accepted decision does not emit. */
  "job_complete.rejected": {
    fact: "transcript.complete_decision",
    source: "api",
    claim: "rejected",
    subject: { job: OTHER_JOB },
    at: "asof",
    synthetic: true,
    value: {
      job_id: OTHER_JOB,
      attempt: 2,
      decision: "rejected",
      reason_code: "transcript.result_verification_failed",
      est_server_ms: "asof",
    },
  },
  /** A retryable finalize-retry decision: no finalize job was retried in the run, so the event is witnessed synthetically. */
  "finalize_retry.retryable": {
    fact: "transcript.finalize_retry_decision",
    source: "api",
    claim: "retryable",
    subject: { job: OTHER_JOB },
    at: "asof",
    synthetic: true,
    value: {
      job_id: OTHER_JOB,
      attempt: 1,
      transcript_error_code: "provider_rejected",
      decision: "retryable",
      reason_code: "transcript.late_completion",
      est_server_ms: "asof",
    },
  },
  /** An errored finalize op carrying reason_code, the one declared transcript.finalize field the captured ok op lacks. */
  "finalize.error": {
    fact: "transcript.finalize_op",
    source: "lambda",
    claim: "error",
    subject: { job: OTHER_JOB },
    at: "asof",
    synthetic: true,
    value: {
      job_id: OTHER_JOB,
      attempt: 1,
      transcript_cue_count: 1,
      outcome: "error",
      reason_code: "transcript.artifact_verification_failed",
      est_server_ms: "asof",
    },
  },
  /** A failed document read: the run never reached a live read, so transcript.document_read is witnessed synthetically. */
  "document_read.error": {
    fact: "transcript.doc",
    source: "api",
    claim: "error",
    subject: { job: OTHER_JOB, episode: OTHER_EPISODE },
    at: "asof",
    synthetic: true,
    value: {
      transcript_route: "document",
      outcome: "error",
      reason_code: "transcript.object_get",
      episode_id: OTHER_EPISODE,
      job_id: OTHER_JOB,
      transcript_cue_count: 0,
      est_server_ms: "asof",
    },
  },
};

/**
 * The extra rows each symptom's positive fixture needs beyond its item's own evidence. `borrow` names real observations the
 * fault scenario picks out of the other captured worlds (`input` is the committed world file, `item` the item inside it);
 * `sweep` and `synthetic` name rows from this file.
 */
const LATE_JOB = "a53efec4-341e-4ecf-b30c-3ceab00b4a25";
const FAILED_JOB = "5d714255-497c-46bd-b3a7-168fe6f8c0c7";
const HEALTHY_JOB = "712aa20d-c655-433f-b04b-d4696c167efd";
const HEALTHY_FIN_JOB = "449afad6-cf36-466c-8df8-8f4fecd69d30";
const HEALTHY_EPISODE = "fc53da9b-32e7-4657-b4f3-d071a6cf5bca";
export default {
  /** The item each symptom's fixtures declare: the positive run's item inside its captured world, and the healthy control's. */
  items: {
    "transcript.attempt_lost": { positive: "0db0d804-c5be-4148-842f-2318467ddef7", healthy: HEALTHY_JOB },
    "transcript.failed": { positive: FAILED_JOB, healthy: HEALTHY_JOB },
    "transcript.late": { positive: LATE_JOB, healthy: HEALTHY_FIN_JOB },
    "transcript.speech_dropped": { positive: "51006a31-15db-47a7-a08f-c79559eddd68", healthy: HEALTHY_FIN_JOB },
    "transcript.stuck": { positive: "0e96f1ef-41e1-4802-abc2-c76ddffd751c", healthy: HEALTHY_JOB },
    "transcript.talk_time_stuck": { positive: "2880ef83-01c5-4f2c-acc4-36450643529d", healthy: HEALTHY_EPISODE },
    "transcript.unreadable": { positive: "902cd3ac-7d50-448b-ab2b-df90af8f83ca", healthy: HEALTHY_FIN_JOB },
    "transcript.wake_lost": { positive: "00e68204-2ea1-418a-9baf-a7609ad7a1c4", healthy: HEALTHY_JOB },
  },
  sweep,
  synthetic,
  needs: {
    "transcript.attempt_lost": {
      borrow: [
        { input: "transcript.attempt_lost.healthy.mjs", item: HEALTHY_JOB, fact: "transcript.attempts" },
        { input: "transcript.attempt_lost.healthy.mjs", item: HEALTHY_JOB, fact: "transcript.complete_decision" },
        { input: "transcript.failed.positive.mjs", item: FAILED_JOB, fact: "transcript.retry_decision" },
        { input: "transcript.failed.positive.mjs", item: FAILED_JOB, fact: "transcript.chunk_op" },
      ],
      sweep: ["claim_none"],
      synthetic: ["db.job.full", "db.attempt.retryable", "job_retry.retryable", "job_complete.rejected"],
    },
    "transcript.failed": {
      borrow: [
        { input: "transcript.late.positive.mjs", item: LATE_JOB, fact: "transcript.row" },
        { input: "transcript.failed.healthy.mjs", item: HEALTHY_EPISODE, fact: "transcript.finalize_op" },
      ],
      sweep: [],
      synthetic: ["db.job.full", "job_retry.retryable", "finalize_retry.retryable", "finalize.error"],
    },
    "transcript.late": {
      borrow: [],
      sweep: [],
      synthetic: ["db.job.full"],
    },
    "transcript.speech_dropped": {
      borrow: [],
      sweep: [],
      synthetic: ["db.attempt.retryable"],
    },
    "transcript.stuck": {
      borrow: [
        { input: "transcript.late.positive.mjs", item: LATE_JOB, fact: "transcript.row" },
        { input: "transcript.late.positive.mjs", item: LATE_JOB, fact: "transcript.finalize_claim_decision" },
        { input: "transcript.failed.positive.mjs", item: FAILED_JOB, fact: "transcript.claim_decision" },
      ],
      sweep: ["claim_none", "finalize_claim_none"],
      synthetic: ["db.job.full", "db.prep.leased", "db.render.succeeded"],
    },
    "transcript.talk_time_stuck": {
      borrow: [{ input: "transcript.talk_time_stuck.healthy.mjs", item: HEALTHY_EPISODE, fact: "transcript.row" }],
      sweep: [],
      synthetic: ["db.prep.leased"],
    },
    "transcript.unreadable": {
      borrow: [{ input: "transcript.late.positive.mjs", item: LATE_JOB, fact: "transcript.object" }],
      sweep: [],
      synthetic: ["document_read.error"],
    },
    "transcript.wake_lost": {
      borrow: [{ input: "transcript.late.positive.mjs", item: LATE_JOB, fact: "transcript.finalize_claim_decision" }],
      sweep: ["claim_none", "finalize_claim_none"],
      synthetic: ["db.job.full"],
    },
  },
};
