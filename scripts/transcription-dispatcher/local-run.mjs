#!/usr/bin/env node
// @ts-check
/**
 * local-run.mjs — dev-only deterministic harness for the Slice-11 transcription
 * observability fault scenarios (docs/plans/hyper-observability/slices/11-transcription.md §6).
 *
 *   seed [--policy on_demand|automatic] [--no-request] [--prep-failed]
 *     Inserts a Tenant, a cf_sfu Space, an Episode ended 3h ago whose
 *     config_snapshot carries the given transcription mode, a completed
 *     Recording, its transcription source chain (reservation, pipeline,
 *     transcription prep job, presentation chain, render input, two committed
 *     render-object allocations, source + one 5000 ms source chunk, prep
 *     commit), copies apps/transcription-dispatcher/test/fixtures/mai-speech.flac
 *     to the chunk's storage key under the host artifact directory and writes a
 *     speaker-turn manifest that speaker-turn-manifest.ts accepts. Unless
 *     --no-request, POSTs /v1/tenants/<t>/recordings/<r>/transcripts and exits
 *     non-zero unless exactly one transcription_chunk artifact job is pending.
 *     --prep-failed makes the transcription prep job terminal_failure with
 *     terminal_at = now() - interval '15 minutes' and never requests.
 *
 *   run [--delay-seconds N]
 *     Builds @chalk/transcription-dispatcher, installs a globalThis.fetch shim,
 *     imports buildHandler from apps/transcription-dispatcher/dist/index.js and
 *     calls the real handler with {source:"reconcile"} until a call claims 0
 *     jobs, at most 5 times. console.info/console.warn append
 *     {"msg":<arg0>, ...<arg1>} JSON lines to .logs/dev/dispatcher.jsonl.
 *
 *   talk-time <episode-id>
 *     GETs /v1/tenants/<t>/spaces/<s>/episodes/<ep>/talk-time with the dev
 *     system token and prints the response status.
 *
 * The fetch shim forwards https://control.chalk.invalid/<path> to the local API
 * unchanged (the workload signature covers the path, not the host), serves
 * GET/PUT/DELETE under /__local-dashboard-artifacts/ from the host artifact
 * directory, and answers openrouter.ai per CHALK_FAKE_PROVIDER
 * (ok | rejected | empty | hang). Every other host fails the run. Signed
 * artifact URLs minted by the local API are http:; the shim flips them to
 * https: inside forwarded control responses because the dispatcher's
 * expiringUrl rejects plain http before fetch is ever called.
 *
 * Postgres runs through `docker exec <container> psql` like verify-stack.mjs;
 * the container comes from CHALK_POSTGRES_CONTAINER or --postgres-container.
 * API calls send Bearer <systemToken> from seed.json; any 401/403 exits non-zero.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resolveDevConfig } from "../dev/config.mjs";
import { runChecked } from "../dev/chalk-resources.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** scripts/dev/dashboard-seed.mjs binds this workload secret into the dev API. */
const WORKLOAD_AUTH_SECRET = "local-dashboard-transcription-not-a-production-secret";
const CONTROL_API_FAKE_ORIGIN = "https://control.chalk.invalid";
const ARTIFACT_URL_PREFIX = "/__local-dashboard-artifacts/";
const FLAC_FIXTURE = "apps/transcription-dispatcher/test/fixtures/mai-speech.flac";
const DISPATCHER_DIST = "apps/transcription-dispatcher/dist/index.js";
const DISPATCHER_PACKAGE = "@chalk/transcription-dispatcher";
const TURN_MS = 5000;
const MAX_HANDLER_CALLS = 5;

/** Every environment variable config.ts:loadReleaseConfig requires, inside its bound. */
const RUN_ENV = {
  CONTROL_API_BASE_URL: CONTROL_API_FAKE_ORIGIN,
  CONTROL_API_AUDIENCE: "chalk-control-api",
  CHALK_ENVIRONMENT: "local",
  CHALK_RELEASE_ID: "dev",
  CODESWITCH_PROVIDER: "mai",
  DEEPINFRA_ENABLED: "true",
  DEEPINFRA_ADAPTER_CONTRACT_VERSION: "deepinfra-native-whisper-turbo.v1",
  DEEPINFRA_CORPUS_DIGEST: "0".repeat(64),
  CLOUDFLARE_AI_ENABLED: "false",
  TRANSCRIPTION_PRIVACY_GATE_ACCEPTED: "true",
  TRANSCRIPTION_PROVIDER_TIMEOUT_MS: "120000",
  TRANSCRIPTION_MAX_AUDIO_BYTES: String(50 * 1024 * 1024),
  TRANSCRIPTION_MAX_AUDIO_SECONDS: "900",
  TRANSCRIPTION_MAX_RESPONSE_BYTES: String(25 * 1024 * 1024),
  TRANSCRIPTION_MAX_TEXT_CHARS: "2000000",
  TRANSCRIPTION_MAX_SEGMENTS: "100000",
  TRANSCRIPTION_MAX_WORDS: "500000",
  TRANSCRIPTION_MAX_RETRIES: "1",
  TRANSCRIPTION_RETRY_BASE_DELAY_MS: "100",
  TRANSCRIPTION_RETRY_MAX_DELAY_MS: "1000",
  TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD: "10",
  TRANSCRIPTION_CIRCUIT_COOLDOWN_MS: "60000",
  TRANSCRIPTION_MAX_BATCH: "5",
  TRANSCRIPTION_CONCURRENCY: "5",
  TRANSCRIPTION_TIMEOUT_RESERVE_MS: "60000",
};

const RUN_SECRETS = {
  workloadAuth: WORKLOAD_AUTH_SECRET,
  openRouterToken: "fake",
  deepInfraToken: "fake",
};

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** A single-quoted SQL literal; callers only feed it generated uuids, hex and fixed strings. */
function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bytea(hex) {
  return `'\\x${hex}'::bytea`;
}

function jsonb(value) {
  return `${q(JSON.stringify(value))}::jsonb`;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value, label) {
  if (!uuidPattern.test(value)) throw new Error(`${label} is not a uuid: ${value}`);
  return value;
}

/** Runs one psql statement batch; ON_ERROR_STOP turns any failure into a non-zero exit. */
async function psql(config, container, statement) {
  const { stdout } = await runChecked("docker", ["exec", container, "psql", "-U", "postgres", "-d", config.databaseName, "-v", "ON_ERROR_STOP=1", "-At", "-F", ",", "-c", statement], { cwd: config.root });
  return stdout;
}

async function postgresContainer(config, flagValue) {
  const container = flagValue || config.postgres.container;
  const { stdout } = await runChecked("docker", ["inspect", "--format", "{{.State.Running}}", container], { cwd: config.root });
  if (stdout.trim() !== "true") throw new Error(`postgres container ${container} is not running (set CHALK_POSTGRES_CONTAINER or --postgres-container)`);
  return container;
}

function hostArtifactRoot(config) {
  return resolve(config.runtimeRoot, "dashboard-artifacts", "__local-dashboard-artifacts");
}

/** Maps a /__local-dashboard-artifacts/<bucket>/<key> URL path to a file below the artifact root. */
function artifactPath(root, pathname) {
  const key = pathname.slice(ARTIFACT_URL_PREFIX.length - 1); // keep the leading slash
  const path = resolve(root, `.${key}`);
  if (!key.startsWith("/") || !path.startsWith(`${root}${sep}`)) throw new Error(`unsafe artifact path: ${pathname}`);
  return path;
}

async function readSeedJson(config) {
  return JSON.parse(await readFile(config.seedPath, "utf8"));
}

async function apiFetch(config, seed, path, { method = "GET", body } = {}) {
  const response = await fetch(`${config.urls.api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${seed.systemToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
  if (response.status === 401 || response.status === 403) throw new Error(`API ${method} ${path} returned ${response.status} (authorization failed)`);
  return response;
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

function seedIds() {
  const recording = randomUUID();
  return {
    tenant: randomUUID(),
    space: randomUUID(),
    episode: randomUUID(),
    recording,
    reservation: randomUUID(),
    job: randomUUID(),
    claim: randomUUID(),
    presentation: randomUUID(),
    input: randomUUID(),
    keyHandle: randomUUID(),
    inputObjectHandle: randomUUID(),
    manifestAllocation: randomUUID(),
    manifestReservation: randomUUID(),
    audioAllocation: randomUUID(),
    audioReservation: randomUUID(),
    audioObjectHandle: randomUUID(),
    manifestObjectHandle: randomUUID(),
    chunk: randomUUID(),
    chunkParticipantRef: `participant-${recording.slice(0, 8)}`,
    requestKey: `local-run-${randomUUID()}`,
  };
}

function episodeSnapshot(mode) {
  return {
    roles: { collaborator: ["publishAudio", "publishVideo", "subscribe"] },
    admission_policy: { mode: "open" },
    default_episode_duration_seconds: 86400,
    maximum_episode_duration_seconds: 86400,
    linger_window_seconds: 0,
    artifact_policy: {
      schema_version: "episode_config.v2",
      recording: { mode: "manual", profile: "composite_720p_v1", retention_seconds: 86400 },
      transcription: { mode, retention_seconds: 0, source_window_seconds: 3600, provider_policy_version: "local-run-v1" },
    },
  };
}

/** The manifest validateSpeakerTurnManifest accepts and describesChunk matches to the chunk row. */
function buildManifest({ ids, presentationShaHex, envelopeShaHex, chunkKey, flacShaHex, flacSize }) {
  return {
    schema_version: "recording-transcription-source.v1",
    tenant_id: ids.tenant,
    recording_id: ids.recording,
    episode_id: ids.episode,
    capture_epoch: 1,
    duration_ms: TURN_MS,
    timebase: "recording_relative_ms",
    presentation_sha256: presentationShaHex,
    producer: { render_job_id: ids.job, attempt_count: 1, fencing_generation: 1, envelope_sha256: envelopeShaHex },
    chunk_policy: { version: "local-run.v1", max_duration_ms: 900000, context_ms: 0, codec: "flac", sample_rate_hz: 16000, channels: 1 },
    chunks: [
      {
        chunk_id: ids.chunk,
        chunk_index: 0,
        generation: 1,
        participant_ref: ids.chunkParticipantRef,
        participant_generation: 1,
        display_name_snapshot: "Ada Fixture",
        identity_kind: "participant",
        track_id: "mic-0",
        track_epoch: "one",
        track_class: "microphone",
        start_ms: 0,
        end_ms: TURN_MS,
        source_start_ms: 0,
        source_end_ms: TURN_MS,
        overlap: false,
        storage: {
          allocation_id: ids.audioAllocation,
          object_key: chunkKey,
          object_version: "version",
          etag: "etag",
          content_type: "audio/flac",
          byte_size: flacSize,
          sha256: flacShaHex,
        },
      },
    ],
  };
}

function seedStatements({ ids, mode, prepFailed, keys, digests, manifestInfo }) {
  const jobState = prepFailed ? "terminal_failure" : "succeeded";
  const jobTerminalAt = prepFailed ? "now() - interval '15 minutes'" : "now()";
  const jobErrorCode = prepFailed ? q("transcription_prepare_failed") : "null";
  const jobErrorDetail = prepFailed ? q("transcription preparation failed after upload") : "null";
  return [
    `insert into tenants (id, name) values (${q(ids.tenant)}, 'transcription local run')`,
    `insert into tenant_artifact_policies (tenant_id, transcription_ceiling, transcription_default_mode, provider_policy_version, source_window_seconds) values (${q(ids.tenant)}, 'automatic', ${q(mode)}, 'local-run-v1', 3600)`,
    `insert into spaces (id, name, tenant_id, slug, media_plane, transcription_policy) values (${q(ids.space)}, 'transcription local run', ${q(ids.tenant)}, ${q(`local-run-${ids.space.slice(0, 8)}`)}, 'cf_sfu', ${q(mode)})`,
    `insert into episodes (id, status, space_id, tenant_id, config_snapshot, started_at, ended_at) values (${q(ids.episode)}, 'ended', ${q(ids.space)}, ${q(ids.tenant)}, ${jsonb(episodeSnapshot(mode))}, now() - interval '3 hours 32 minutes', now() - interval '3 hours')`,
    `insert into recordings (id, tenant_id, space_id, episode_id, status, storage_provider, completed_at) values (${q(ids.recording)}, ${q(ids.tenant)}, ${q(ids.space)}, ${q(ids.episode)}, 'completed', 'r2', now() - interval '3 hours')`,
    `insert into recording_reservations (id, tenant_id, space_id, episode_id, recording_id, idempotency_key, request_fingerprint, policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state, ends_at) values (${q(ids.reservation)}, ${q(ids.tenant)}, ${q(ids.space)}, ${q(ids.episode)}, ${q(ids.recording)}, ${q(`local-run-reservation-${ids.reservation}`)}, ${bytea(digests.fingerprint)}, 'episode_config.v2', 1, 3600, 1000, 'reserved', now() + interval '1 hour')`,
    `insert into recording_pipelines (recording_id, tenant_id, reservation_id, capture_epoch, state, capture_completed_at) values (${q(ids.recording)}, ${q(ids.tenant)}, ${q(ids.reservation)}, 1, 'capture_complete', now())`,
    `insert into recording_jobs (id, tenant_id, episode_id, recording_id, kind, idempotency_key, payload_schema_version, state, available_at, attempt_count, attempt_limit, error_code, error_detail, terminal_at, fencing_generation) values (${q(ids.job)}, ${q(ids.tenant)}, ${q(ids.episode)}, ${q(ids.recording)}, 'transcription', ${q(`local-run-job-${ids.job}`)}, 1, ${q(jobState)}, now(), 1, ${prepFailed ? 1 : 3}, ${jobErrorCode}, ${jobErrorDetail}, ${jobTerminalAt}, 1)`,
    `insert into recording_job_attempt_authorities (job_id, attempt_count, fencing_generation, capture_epoch, claim_request_id, kind, lease_owner, lease_token, lease_expires_at, envelope_bytes, envelope_digest) values (${q(ids.job)}, 1, 1, 1, ${q(ids.claim)}, 'transcription', 'local-run-worker', 'local-run-lease', now() + interval '1 hour', ${bytea(digests.envelopeBytes)}, ${bytea(digests.envelope)})`,
    `insert into recording_presentation_baselines (presentation_handle, tenant_id, space_id, episode_id, recording_id, schema_version, profile_version, profile, space_name, episode_control_revision, episode_folded_state, participant_facts, chat_head_sequence, baseline_at) values (${q(ids.presentation)}, ${q(ids.tenant)}, ${q(ids.space)}, ${q(ids.episode)}, ${q(ids.recording)}, 'recording_presentation.v1', 'profile.v1', ${jsonb({ version: "profile.v1" })}, 'transcription local run', 0, '{}'::jsonb, '[]'::jsonb, 0, now())`,
    `insert into recording_presentation_sources (presentation_handle, tenant_id, space_id, episode_id, recording_id, capture_epoch, capture_ready_at, episode_control_start_revision, episode_control_events, episode_control_end_revision, participant_facts, chat_start_sequence, initial_chat_messages, whiteboard_start_revision, whiteboard_events, whiteboard_end_revision, capture_plan_start_revision) values (${q(ids.presentation)}, ${q(ids.tenant)}, ${q(ids.space)}, ${q(ids.episode)}, ${q(ids.recording)}, 1, now(), 0, '[]'::jsonb, 0, '[]'::jsonb, 0, '[]'::jsonb, 0, '[]'::jsonb, 0, 0)`,
    `insert into recording_presentations (presentation_handle, tenant_id, space_id, episode_id, recording_id, capture_epoch, schema_version, profile_version, duration_millis, presentation_sha256, presentation_object_key, presentation_object_version, presentation_object_etag, presentation_content_type, presentation_byte_size, asset_manifest_object_key, asset_manifest_object_version, asset_manifest_object_etag, asset_manifest_content_type, asset_manifest_byte_size, asset_manifest_sha256, frozen_at) values (${q(ids.presentation)}, ${q(ids.tenant)}, ${q(ids.space)}, ${q(ids.episode)}, ${q(ids.recording)}, 1, 'recording_presentation.v1', 'profile.v1', ${TURN_MS}, ${bytea(digests.presentation)}, 'local-run/presentation.json', 'version', 'etag', 'application/json', 1, 'local-run/assets.json', 'version', 'etag', 'application/json', 1, ${bytea(digests.assets)}, now())`,
    `insert into recording_render_inputs (render_input_handle, tenant_id, space_id, episode_id, recording_id, render_job_id, attempt_count, fencing_generation, capture_epoch, envelope_digest, key_handle, object_handle, presentation_handle, presentation_schema_version, presentation_profile_version, presentation_sha256, presentation_duration_millis, capture_ready_at) values (${q(ids.input)}, ${q(ids.tenant)}, ${q(ids.space)}, ${q(ids.episode)}, ${q(ids.recording)}, ${q(ids.job)}, 1, 1, 1, ${bytea(digests.envelope)}, ${q(ids.keyHandle)}, ${q(ids.inputObjectHandle)}, ${q(ids.presentation)}, 'recording_presentation.v1', 'profile.v1', ${bytea(digests.presentation)}, ${TURN_MS}, now())`,
    `insert into recording_render_object_allocations (id, reservation_request_id, allocation_version, tenant_id, episode_id, recording_id, render_job_id, render_input_handle, object_handle, attempt_count, fencing_generation, capture_epoch, envelope_digest, purpose, state, object_key, expected_content_type, expected_byte_size, expected_sha256, expected_duration_millis, upload_token_hash, upload_expires_at, object_version, object_etag, object_content_type, object_byte_size, object_sha256, committed_at) values (${q(ids.manifestAllocation)}, ${q(ids.manifestReservation)}, 1, ${q(ids.tenant)}, ${q(ids.episode)}, ${q(ids.recording)}, ${q(ids.job)}, ${q(ids.input)}, ${q(ids.manifestObjectHandle)}, 1, 1, 1, ${bytea(digests.envelope)}, 'transcription_manifest', 'committed', ${q(keys.manifest)}, 'application/json', ${manifestInfo.byteLength}, ${bytea(manifestInfo.sha)}, null, ${bytea(digests.manifestUploadToken)}, now() + interval '1 hour', 'version', 'etag', 'application/json', ${manifestInfo.byteLength}, ${bytea(manifestInfo.sha)}, now())`,
    `insert into recording_render_object_allocations (id, reservation_request_id, allocation_version, tenant_id, episode_id, recording_id, render_job_id, render_input_handle, object_handle, attempt_count, fencing_generation, capture_epoch, envelope_digest, purpose, state, object_key, expected_content_type, expected_byte_size, expected_sha256, expected_duration_millis, upload_token_hash, upload_expires_at, object_version, object_etag, object_content_type, object_byte_size, object_sha256, committed_at) values (${q(ids.audioAllocation)}, ${q(ids.audioReservation)}, 2, ${q(ids.tenant)}, ${q(ids.episode)}, ${q(ids.recording)}, ${q(ids.job)}, ${q(ids.input)}, ${q(ids.audioObjectHandle)}, 1, 1, 1, ${bytea(digests.envelope)}, 'transcription_audio', 'committed', ${q(keys.chunk)}, 'audio/flac', ${digests.flacSize}, ${bytea(digests.flacSha)}, ${TURN_MS}, ${bytea(digests.audioUploadToken)}, now() + interval '1 hour', 'version', 'etag', 'audio/flac', ${digests.flacSize}, ${bytea(digests.flacSha)}, now())`,
    `insert into recording_transcription_sources (recording_id, tenant_id, manifest_key, manifest_sha256, manifest_size, manifest_content_type, schema_version, committed_at, generation, commit_digest, presentation_sha256, manifest_allocation_id, manifest_object_version, manifest_etag, status, expires_at) values (${q(ids.recording)}, ${q(ids.tenant)}, ${q(keys.manifest)}, ${bytea(manifestInfo.sha)}, ${manifestInfo.byteLength}, 'application/json', 1, now(), 1, ${bytea(digests.commit)}, ${bytea(digests.presentation)}, ${q(ids.manifestAllocation)}, 'version', 'etag', 'ready', now() + interval '2 hours')`,
    `insert into recording_transcription_source_chunks (id, recording_id, tenant_id, chunk_index, generation, start_ms, end_ms, source_start_ms, source_end_ms, participant_ref, participant_generation, track_id, track_epoch, identity_kind, track_class, display_name_snapshot, overlap, storage_key, allocation_id, object_version, object_etag, checksum, size, content_type) values (${q(ids.chunk)}, ${q(ids.recording)}, ${q(ids.tenant)}, 0, 1, 0, ${TURN_MS}, 0, ${TURN_MS}, ${q(ids.chunkParticipantRef)}, 1, 'mic-0', 'one', 'participant', 'microphone', 'Ada Fixture', false, ${q(keys.chunk)}, ${q(ids.audioAllocation)}, 'version', 'etag', ${bytea(digests.flacSha)}, ${digests.flacSize}, 'audio/flac')`,
    `insert into recording_transcription_preparation_commits (transcription_job_id, tenant_id, recording_id, attempt_count, fencing_generation, capture_epoch, render_input_handle, commit_digest, presentation_sha256, duration_millis, transcription_source_id) values (${q(ids.job)}, ${q(ids.tenant)}, ${q(ids.recording)}, 1, 1, 1, ${q(ids.input)}, ${bytea(digests.commit)}, ${bytea(digests.presentation)}, ${TURN_MS}, ${q(ids.recording)})`,
  ];
}

async function cmdSeed(config, flags) {
  const mode = flags.get("policy") ?? "on_demand";
  if (mode !== "on_demand" && mode !== "automatic") throw new Error(`--policy must be on_demand or automatic, got ${mode}`);
  const noRequest = flags.has("no-request");
  const prepFailed = flags.has("prep-failed");
  const container = await postgresContainer(config, flags.get("postgres-container"));

  const ids = seedIds();
  const artifactRoot = hostArtifactRoot(config);
  const chunkKey = `tenants/${ids.tenant}/recordings/${ids.recording}/transcription/chunk-0.flac`;
  const manifestKey = `tenants/${ids.tenant}/recordings/${ids.recording}/transcription/source-manifest.json`;
  const keys = { chunk: chunkKey, manifest: manifestKey };

  const flac = await readFile(join(config.root, FLAC_FIXTURE));
  const flacShaHex = sha256Hex(flac);
  const flacSize = flac.byteLength;

  const envelopeBytes = Buffer.from('{"completion_only":false}');
  const digests = {
    fingerprint: sha256Hex(`local-run-fingerprint:${ids.reservation}`),
    envelopeBytes: envelopeBytes.toString("hex"),
    envelope: sha256Hex(envelopeBytes),
    presentation: sha256Hex(`local-run-presentation:${ids.recording}`),
    commit: sha256Hex(`local-run-commit:${ids.recording}`),
    assets: sha256Hex(`local-run-assets:${ids.presentation}`),
    manifestUploadToken: sha256Hex(`local-run-upload:${ids.manifestAllocation}`),
    audioUploadToken: sha256Hex(`local-run-upload:${ids.audioAllocation}`),
    flacSha: flacShaHex,
    flacSize,
  };

  const manifest = buildManifest({ ids, presentationShaHex: digests.presentation, envelopeShaHex: digests.envelope, chunkKey, flacShaHex, flacSize });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestInfo = { byteLength: manifestBytes.byteLength, sha: sha256Hex(manifestBytes) };

  // Storage objects land on the host artifact tree before the rows that attest them.
  const chunkPath = artifactPath(artifactRoot, `${ARTIFACT_URL_PREFIX}local-dashboard/${chunkKey}`);
  const manifestPath = artifactPath(artifactRoot, `${ARTIFACT_URL_PREFIX}local-dashboard/${manifestKey}`);
  await mkdir(dirname(chunkPath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  await copyFile(join(config.root, FLAC_FIXTURE), chunkPath);
  await writeFile(manifestPath, manifestBytes);

  const statements = seedStatements({ ids, mode, prepFailed, keys, digests, manifestInfo });
  await psql(config, container, `begin;\n${statements.join(";\n")};\ncommit;`);

  let job = "-";
  const shouldRequest = !noRequest && !prepFailed;
  if (shouldRequest) {
    const seed = await readSeedJson(config);
    const response = await apiFetch(config, seed, `/v1/tenants/${ids.tenant}/recordings/${ids.recording}/transcripts`, {
      method: "POST",
      body: JSON.stringify({ idempotency_key: ids.requestKey }),
    });
    if (response.status !== 202) throw new Error(`transcript request returned ${response.status}: ${await response.text()}`);
    const rows = (await psql(config, container, `select id::text from artifact_jobs where recording_id = ${q(ids.recording)} and artifact_kind = 'transcription_chunk' and state = 'pending' order by created_at`)).trim().split("\n").filter(Boolean);
    if (rows.length !== 1) throw new Error(`expected exactly one pending transcription_chunk job, found ${rows.length}`);
    job = rows[0];
  }
  process.stdout.write(`ep=${ids.episode} rec=${ids.recording} job=${job}\n`);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const FAKE_PROVIDER_BODIES = {
  ok: {
    text: "hello there",
    segments: [{ start: 0.1, end: 1.0, text: "hello there" }],
    words: [
      { word: "hello", start: 0.1, end: 0.5 },
      { word: "there", start: 0.5, end: 1.0 },
    ],
    usage: { cost: 0 },
  },
  empty: { text: "", segments: [], words: [], usage: { cost: 0 } },
};

function contentTypeFor(path) {
  if (path.endsWith(".flac")) return "audio/flac";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function requestBytes(input, init) {
  if (init?.body !== undefined && init?.body !== null) {
    const body = init.body;
    if (typeof body === "string") return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    if (typeof body.arrayBuffer === "function") return Buffer.from(await body.arrayBuffer());
    return Buffer.from(String(body));
  }
  if (typeof input === "object" && input !== null && typeof input.arrayBuffer === "function") {
    const buffer = await input.arrayBuffer();
    return buffer.byteLength === 0 ? undefined : Buffer.from(buffer);
  }
  return undefined;
}

/** Rewrites http: artifact URLs to https: so the dispatcher's expiringUrl accepts the local stack's signed URLs. */
function upgradeArtifactUrls(value) {
  if (typeof value === "string") {
    if (!value.startsWith("http://")) return value;
    try {
      const url = new URL(value);
      if (!url.pathname.startsWith(ARTIFACT_URL_PREFIX)) return value;
      url.protocol = "https:";
      return url.toString();
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(upgradeArtifactUrls);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = upgradeArtifactUrls(item);
    return out;
  }
  return value;
}

function installFetchShim({ config, artifactRoot, realFetch }) {
  const apiBase = config.urls.api;
  return async function shimFetch(input, init) {
    const raw = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
    const url = new URL(raw);
    const method = String(init?.method ?? (typeof input === "object" && input?.method) ?? "GET").toUpperCase();
    process.stderr.write(`shim ${method} ${url.host}${url.pathname}\n`);

    if (url.origin === CONTROL_API_FAKE_ORIGIN) {
      const body = method === "GET" || method === "HEAD" ? undefined : await requestBytes(input, init);
      const response = await realFetch(`${apiBase}${url.pathname}${url.search}`, {
        method,
        headers: init?.headers ?? (typeof input === "object" ? input?.headers : undefined),
        ...(body === undefined ? {} : { body }),
        ...(init?.signal ? { signal: init.signal } : {}),
        redirect: "manual",
      });
      if (response.status === 401 || response.status === 403) throw new Error(`control API ${url.pathname} returned ${response.status} (workload authorization failed)`);
      const bytes = Buffer.from(await response.arrayBuffer());
      let payload = bytes;
      try {
        const parsed = JSON.parse(bytes.toString("utf8"));
        payload = Buffer.from(JSON.stringify(upgradeArtifactUrls(parsed)));
      } catch {
        // Not JSON: forward untouched.
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(payload.byteLength === 0 ? null : payload, { status: response.status, statusText: response.statusText, headers });
    }

    if (url.pathname.startsWith(ARTIFACT_URL_PREFIX)) {
      const path = artifactPath(artifactRoot, url.pathname);
      if (method === "GET" || method === "HEAD") {
        try {
          const bytes = await readFile(path);
          return new Response(method === "GET" ? bytes : null, { status: 200, headers: { "content-type": contentTypeFor(path), "content-length": String(bytes.byteLength) } });
        } catch {
          return new Response("not found", { status: 404 });
        }
      }
      if (method === "PUT") {
        const body = await requestBytes(input, init);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body ?? Buffer.alloc(0));
        return new Response(null, { status: 200 });
      }
      if (method === "DELETE") {
        try {
          await unlink(path);
        } catch {
          // Already gone: the cleanup path tolerates a missing object.
        }
        return new Response(null, { status: 204 });
      }
      throw new Error(`unsupported artifact method ${method} ${url.pathname}`);
    }

    if (url.hostname === "openrouter.ai") {
      const mode = process.env.CHALK_FAKE_PROVIDER || "ok";
      if (mode === "hang") {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error("provider request aborted"));
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("provider request aborted")), { once: true });
          // Otherwise never settles, like a wedged provider socket.
        });
      }
      if (mode === "rejected") {
        return new Response(JSON.stringify({ error: { message: "fake provider rejection" } }), { status: 400, headers: { "content-type": "application/json" } });
      }
      const body = FAKE_PROVIDER_BODIES[mode];
      if (!body) throw new Error(`unknown CHALK_FAKE_PROVIDER mode: ${mode}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }

    throw new Error(`unexpected fetch target: ${url.origin}${url.pathname}`);
  };
}

function installJsonlLog(logPath) {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const append = (args) => {
    const [msg, fields] = args;
    const record = { msg };
    if (fields && typeof fields === "object" && !Array.isArray(fields)) Object.assign(record, fields);
    appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  };
  console.info = (...args) => {
    append(args);
    originalInfo.apply(console, args);
  };
  console.warn = (...args) => {
    append(args);
    originalWarn.apply(console, args);
  };
  return () => {
    console.info = originalInfo;
    console.warn = originalWarn;
  };
}

async function cmdRun(config, flags) {
  const delaySeconds = Number(flags.get("delay-seconds") ?? "0");
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) throw new Error(`--delay-seconds must be a non-negative number, got ${flags.get("delay-seconds")}`);
  if (delaySeconds > 0) await delay(delaySeconds * 1000);

  await runChecked("pnpm", ["--filter", DISPATCHER_PACKAGE, "build"], { cwd: config.root });

  await mkdir(config.logRoot, { recursive: true });
  const logPath = join(config.logRoot, "dispatcher.jsonl");
  const restoreConsole = installJsonlLog(logPath);

  const artifactRoot = hostArtifactRoot(config);
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = installFetchShim({ config, artifactRoot, realFetch });

  const distUrl = pathToFileURL(join(config.root, DISPATCHER_DIST)).href;
  const { buildHandler } = await import(distUrl);
  const handler = buildHandler(RUN_ENV, RUN_SECRETS);

  process.stdout.write(`pid=${process.pid}\n`);

  try {
    let calls = 0;
    let summary = { claimed: 0, completed: 0, failed: 0 };
    while (calls < MAX_HANDLER_CALLS) {
      calls += 1;
      summary = await handler({ source: "reconcile" }, { getRemainingTimeInMillis: () => 300000 });
      process.stdout.write(`call=${calls} claimed=${summary.claimed} completed=${summary.completed} failed=${summary.failed}\n`);
      if (summary.claimed === 0) break;
    }
    if (summary.claimed > 0) process.stdout.write(`note: ${summary.claimed} job(s) remained claimed after ${MAX_HANDLER_CALLS} calls\n`);
  } finally {
    restoreConsole();
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// talk-time
// ---------------------------------------------------------------------------

async function cmdTalkTime(config, flags, positionals) {
  const episodeId = assertUuid(positionals[0] ?? "", "episode id");
  const container = await postgresContainer(config, flags.get("postgres-container"));
  const row = (await psql(config, container, `select tenant_id, space_id from episodes where id = ${q(episodeId)}`)).trim();
  if (!row) throw new Error(`episode ${episodeId} not found`);
  const [tenantId, spaceId] = row.split(",");
  const seed = await readSeedJson(config);
  const response = await apiFetch(config, seed, `/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/talk-time`);
  if (response.status !== 200) throw new Error(`talk-time returned ${response.status}: ${await response.text()}`);
  const body = await response.json();
  process.stdout.write(`${body.status}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/transcription-dispatcher/local-run.mjs <command> [options]

Commands:
  seed [--policy on_demand|automatic] [--no-request] [--prep-failed]
      Seed a tenant/space/episode/recording/transcription-source fixture and,
      unless --no-request or --prep-failed, request its transcript.
      Prints: ep=<id> rec=<id> job=<id>

  run [--delay-seconds N]
      Build and invoke the real transcription dispatcher against the local dev
      stack until a call claims zero jobs (at most 5 calls).
      CHALK_FAKE_PROVIDER selects the fake provider: ok | rejected | empty | hang.

  talk-time <episode-id>
      Print the episode's talk-time status.

Options:
  --postgres-container <name>   Postgres container (default: CHALK_POSTGRES_CONTAINER or chalk-postgres)
  --help, -h                    Show this help
`;

function parseFlags(args) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token === "-h") {
      flags.set("help", true);
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const name = token.slice(2);
      if (["policy", "delay-seconds", "postgres-container"].includes(name)) {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
        flags.set(name, value);
        index += 1;
        continue;
      }
      flags.set(name, true);
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help" || command === undefined) {
    process.stdout.write(USAGE);
    return;
  }
  const { flags, positionals } = parseFlags(rest);
  if (flags.has("help") || flags.has("h")) {
    process.stdout.write(USAGE);
    return;
  }
  const config = resolveDevConfig({ root: REPO_ROOT });
  if (command === "seed") return cmdSeed(config, flags);
  if (command === "run") return cmdRun(config, flags);
  if (command === "talk-time") return cmdTalkTime(config, flags, positionals);
  throw new Error(`unknown command: ${command}`);
}

main(process.argv.slice(2)).then(
  () => {},
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  },
);
