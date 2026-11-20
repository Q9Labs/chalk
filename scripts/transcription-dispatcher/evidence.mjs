#!/usr/bin/env node
// @ts-check
/**
 * The slice-11 (transcription) evidence reader: turns the real stores of a dev or live transcription run into the `World`
 * that `diagnose --fixture` judges through the reference adapters in scripts/diagnose-call/proof/fixture-world.mjs.
 *
 * Three witnesses, three readers:
 *
 * - `db` is the authority. Postgres is read through the dev stack's container (`docker exec <postgres.container> psql`),
 *   resolved by scripts/dev/config.mjs the way scripts/dev/verify-stack.mjs does. Every db observation is
 *   `origin.measured("db")` over a window spanning `[row created .. the read]`: a checker-read fact claims the row as it
 *   stands now over the subject's whole life, and the kernel only counts what overlaps the item's judged window — a
 *   Recording that completed before its transcription job was created still witnesses it this way. Rows the item needs
 *   that do not exist emit a `none` claim with `transcript_exists: false` instead, the registry's idiom for "the reader
 *   looked and the row is absent", so their readings are `present` and the checks can pass on them.
 * - `api` and `lambda` are local dev logs when `CHALK_DIAGNOSE_LOCAL_LOGS` names a directory: `api.log` is the API's slog
 *   JSON output and `dispatcher.jsonl` is the dispatcher's JSON-lines kernel records. Rows map to observations by the
 *   registry the way proof/rows.mjs maps Axiom rows — an observation only for an event whose fact names a source equal to
 *   the log's, so a `transcript.chunk` line can never read as an `api` row or vice versa.
 * - `r2` is the checker's own readback of the stored document. `CHALK_DIAGNOSE_R2_DIR` reads from the host artifact
 *   directory; otherwise the four `CHALK_DIAGNOSE_R2_*` variables drive a SigV4 GET built with `node:crypto` alone.
 *
 * Honest coverage: a source that was not read gets a watermark with `complete_to_ms: null`, never fabricated completeness.
 * A db read that fails throws to the caller; nothing silently claims a row. Subjects are canonical uuids, never display
 * handles. Object keys, signed URLs, tokens, transcript text and bodies never appear in observations, queries or notes.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { createHash, createHmac } from "node:crypto";
import { FACTS } from "../diagnose-call/proof/facts.mjs";
import { observation, origin } from "../diagnose-call/proof/evidence.mjs";
import { ITEM } from "../diagnose-call/proof/profile.mjs";
import { resolveDevConfig } from "../dev/config.mjs";

/** @typedef {import("../diagnose-call/proof/fixture-world.mjs").World} World */
/** @typedef {import("../diagnose-call/proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../diagnose-call/proof/evidence.mjs").Watermark} Watermark */
/** @typedef {import("../diagnose-call/proof/evidence.mjs").EvidenceGap} EvidenceGap */
/** @typedef {import("../diagnose-call/proof/evidence.mjs").Subject} Subject */
/** @typedef {import("../diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../diagnose-call/proof/profile.mjs").OpenWindow} OpenWindow */
/** @typedef {import("../diagnose-call/proof/fixture-world.mjs").Evidence} Evidence */
/** @typedef {Readonly<Record<string, unknown>>} Row */
/** @typedef {{ file: string, source: "api" | "lambda", read_ms: number, mtime_ms: number, rows: { raw: Record<string, unknown>, line: string }[], skipped: number }} LogRead */

const registry = JSON.parse(readFileSync(new URL("../../observability/generated/registry.json", import.meta.url), "utf8"));
/** Registry record `kind` of each registered event (op, decision, fact, transition, surface). */
const EVENT_KIND = new Map(registry.events.map((/** @type {{ name: string, kind: string }} */ event) => [event.name, event.kind]));
const RECORD_KINDS = new Set(registry.kinds);

/**
 * The facts one registry event witnesses, per fact-event entry: a `transcript.claim` row witnesses `transcript.claim_decision`
 * for the `api` source. An event listed by two facts yields one observation each, the way proof/rows.mjs handles it.
 * @type {ReadonlyMap<string, readonly { fact: string, source: string, claim: string, failure_claims: readonly string[], fields: ReadonlySet<string> }[]>}
 */
const BY_EVENT = (() => {
  /** @type {Map<string, { fact: string, source: string, claim: string, failure_claims: readonly string[], fields: Set<string> }[]>} */
  const map = new Map();
  for (const [fact, def] of Object.entries(FACTS)) {
    for (const event of def.events) {
      const entry = { fact, source: event.source, claim: event.claim, failure_claims: event.failure_claims ?? [], fields: new Set(event.fields) };
      map.set(event.event, [...(map.get(event.event) ?? []), entry]);
    }
  }
  return map;
})();

/** The facts each source can emit for this slice: every registry fact with an event on that source. */
const EMITS = (() => {
  /** @type {Map<string, string[]>} */
  const emits = new Map();
  for (const [fact, def] of Object.entries(FACTS)) {
    for (const event of def.events) emits.set(event.source, [...(emits.get(event.source) ?? []), fact]);
  }
  return new Map([...emits.entries()].map(([source, facts]) => [source, [...new Set(facts)].sort()]));
})();

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const OPEN_JOB_STATES = "'pending','leased','retryable'";
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** A store the reader needs is missing, unreadable or misconfigured. */
export class EvidenceError extends Error {}

/* -------------------------------------------------------------------------- */
/* db                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One statement against the dev Postgres, exactly as scripts/dev/verify-stack.mjs runs it. `ON_ERROR_STOP` makes a query
 * failure an exit code, and the failure propagates — an unreachable db is never reported as covered. No credentials exist on
 * the local dev container, so nothing sensitive can appear on the command line or in psql's error.
 * @param {{ postgres: { container: string }, databaseName: string }} config
 * @param {string} sql a statement returning a single JSON value (`row_to_json` or `json_agg`)
 */
async function readDb(config, sql) {
  const { stdout } = await run("docker", ["exec", config.postgres.container, "psql", "-U", "postgres", "-d", config.databaseName, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { maxBuffer: 32 << 20 }).catch((error) => {
    const stderr = /** @type {{ stderr?: unknown }} */ (error).stderr;
    throw new EvidenceError(`Postgres refused the read via docker exec ${config.postgres.container}: ${typeof stderr === "string" ? stderr.trim().split("\n")[0] : String(error.message ?? error)}`, { cause: error });
  });
  const trimmed = stdout.trim();
  return trimmed === "" ? null : JSON.parse(trimmed);
}

/** Epoch milliseconds of a timestamptz column, null-safe in SQL. */
const msOf = (/** @type {string} */ column) => `floor(extract(epoch from ${column}) * 1000)::bigint`;

/** A db row's numeric timestamp, or null when the column is NULL. */
const timeOf = (/** @type {Row} */ row, /** @type {string} */ field) => (typeof row[field] === "number" ? /** @type {number} */ (row[field]) : null);

/**
 * The columns the transcription observation needs, shared by the by-id and by-recording reads. `artifact_key` and
 * `artifact_sha256` are reader internals for the r2 readback — they never reach an observation value.
 */
const TRANSCRIPTION_COLUMNS = `t.id, t.recording_id, t.status, t.provider, (t.deleted_at is not null) as deleted, ${msOf("t.created_at")} as created_ms, ${msOf("t.updated_at")} as updated_ms, ${msOf("t.completed_at")} as completed_ms, ${msOf("t.deleted_at")} as deleted_ms, (t.artifact_key is not null and t.artifact_size is not null and t.artifact_content_type is not null) as artifact_set, (t.artifact_sha256 is not null) as sha_set, t.artifact_key, t.artifact_size, t.artifact_content_type, encode(t.artifact_sha256, 'hex') as artifact_sha256, t.generation, (select count(*)::int from artifact_jobs s where s.transcript_id = t.id and s.state in (${OPEN_JOB_STATES})) as open_jobs, (select count(*)::int from artifact_jobs s where s.transcript_id = t.id and s.state = 'dead_letter') as dead_letter_jobs`;

/** One transcription row as a JSON object, or null. */
const transcriptionBy = (/** @type {string} */ where) => `select row_to_json(t) from (select ${TRANSCRIPTION_COLUMNS} from transcriptions t where ${where}) t`;

/** Every matching transcription row as a JSON array (`[]` when none), ordered by recording. */
const transcriptionsBy = (/** @type {string} */ where) => `select coalesce(json_agg(row_to_json(t) order by t.recording_id), '[]'::json) from (select ${TRANSCRIPTION_COLUMNS} from transcriptions t where ${where}) t`;

/* -------------------------------------------------------------------------- */
/* log (api.log / dispatcher.jsonl)                                            */
/* -------------------------------------------------------------------------- */

/**
 * One JSON-lines log file as parsed rows. A missing or unreadable file throws so the caller can mark the source unread —
 * it never fabricates the source's coverage. Lines that don't parse as a JSON object are skipped and counted; the spec's dev
 * logs can mix kernel records with plain text.
 * @param {string} file
 * @param {"api" | "lambda"} source
 * @returns {LogRead}
 */
function loadLog(file, source) {
  const read_ms = Date.now();
  const stat = statSync(file); // throws: a missing file means this source is not read
  /** @type {LogRead["rows"]} */
  const rows = [];
  let skipped = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let raw;
    try {
      // The dev stack tees some lines through a `[<iso>]` prefix; strip it before parsing.
      const json = trimmed.startsWith("[") ? trimmed.slice(trimmed.indexOf("]") + 1).trim() : trimmed;
      raw = JSON.parse(json);
    } catch {
      skipped += 1;
      continue;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      skipped += 1;
      continue;
    }
    rows.push({ raw, line: trimmed });
  }
  return { file, source, read_ms, mtime_ms: stat.mtimeMs, rows, skipped };
}

/**
 * The registered event a row records: `name` on a kernel row (record `kind` set), or `name`/`event` naming a registered event —
 * the local dispatcher writes plain `{event: "..."}` lines beside kernel rows. Anything else produces no observation.
 * @param {Record<string, unknown>} row
 */
function eventNameOf(row) {
  if (typeof row.name === "string" && RECORD_KINDS.has(String(row.kind))) return row.name;
  if (typeof row.name === "string" && EVENT_KIND.has(row.name)) return row.name;
  if (typeof row.event === "string" && EVENT_KIND.has(row.event)) return row.event;
  return undefined;
}

/** The row's event name, registered or not (`dispatcher_claimed`, `dispatcher_completed`) — for gap detection only. */
const plainNameOf = (/** @type {Record<string, unknown>} */ row) => (typeof row.event === "string" ? row.event : typeof row.name === "string" ? row.name : typeof row.msg === "string" ? row.msg : undefined);

/**
 * A row's server time: `est_server_ms` on kernel rows, else the line's `time`/`_time`/`timestamp`, else the file's mtime. Like
 * proof/rows.mjs, `clock_err_ms` widens the point and `duration_ms` extends it into a range.
 * @param {Record<string, unknown>} row
 * @param {number} fallback
 * @returns {OpenWindow & { to_ms: number }}
 */
function rowWindow(row, fallback) {
  let at = fallback;
  if (typeof row.est_server_ms === "number") {
    at = row.est_server_ms;
  } else {
    for (const field of ["_time", "time", "timestamp"]) {
      const parsed = typeof row[field] === "string" ? Date.parse(/** @type {string} */ (row[field])) : NaN;
      if (Number.isFinite(parsed)) {
        at = parsed;
        break;
      }
    }
  }
  if (typeof row.duration_ms === "number") return { from_ms: at, to_ms: at + row.duration_ms };
  const err = typeof row.clock_err_ms === "number" ? row.clock_err_ms : 0;
  return { from_ms: at - err, to_ms: at + err };
}

const rowTime = (/** @type {Record<string, unknown>} */ row, /** @type {number} */ fallback) => rowWindow(row, fallback).to_ms;

/**
 * One log row's observations: one per fact whose event entry both lists the row's event and belongs to this log's source.
 * The value keeps only the field names the fact's event declares for that source, so envelope noise (`msg`, `level`,
 * `service`, `seq`, `source_id`) and unregistered detail can never reach a rule.
 * @param {LogRead["rows"][number]} entry
 * @param {LogRead} log
 * @param {Readonly<Subject>} subject canonical ids of the item this row names, already resolved through the db join
 * @returns {Observation[]}
 */
function logObservations(entry, log, subject) {
  const name = eventNameOf(entry.raw);
  if (name === undefined) return [];
  const witnessed = (BY_EVENT.get(name) ?? []).filter((candidate) => candidate.source === log.source);
  if (witnessed.length === 0) return [];
  const raw = entry.raw;
  const id = typeof raw.event_id === "string" && raw.event_id !== "" ? raw.event_id : stableId(`log|${log.source}|${log.file}|${entry.line}`);
  const window = rowWindow(raw, log.mtime_ms);
  const kind = EVENT_KIND.get(name);
  /** @type {Observation[]} */
  const observations = [];
  for (const candidate of witnessed) {
    const claimed = raw[candidate.claim];
    if (claimed === undefined || claimed === null) continue;
    /** @type {Record<string, string | number | boolean>} */
    const value = {};
    for (const field of candidate.fields) {
      const fieldValue = raw[field];
      if (typeof fieldValue === "string" || typeof fieldValue === "number" || typeof fieldValue === "boolean") value[field] = fieldValue;
    }
    observations.push(
      observation({
        id,
        fact: candidate.fact,
        source: log.source,
        origin: kind === "decision" || typeof raw.decision_id === "string" ? origin.decision(typeof raw.decision_id === "string" ? raw.decision_id : id) : origin.measured(log.source),
        subject,
        window,
        claim: String(claimed),
        value,
        failure: candidate.failure_claims.includes(String(claimed)),
        query: `grep '"name":"${name}"' ${basename(log.file)} | grep '${id}'`,
      }),
    );
  }
  return observations;
}

/* -------------------------------------------------------------------------- */
/* r2                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The transcript.v1 document validation the readback performs — the same checks `persistedDocument.validate` makes at
 * apps/api/internal/transcripts/document.go:147, so `invalid` means what the API's decode would mean. Returns cue count and
 * provider on success so the observation can carry them, null on any violation.
 * @param {unknown} document
 * @returns {{ cues: number, provider: string | null } | null}
 */
function validateDocument(document) {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return null;
  const doc = /** @type {Record<string, unknown>} */ (document);
  const nonEmpty = (/** @type {unknown} */ value) => typeof value === "string" && value !== "";
  const nonNegative = (/** @type {unknown} */ value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const qualityOk = (/** @type {unknown} */ value) => {
    if (value === undefined || value === null) return true;
    if (typeof value !== "object") return false;
    const q = /** @type {Record<string, unknown>} */ (value);
    return nonNegative(q.segmentCount) && nonNegative(q.wordCount) && (q.meanConfidence === undefined || (typeof q.meanConfidence === "number" && q.meanConfidence >= 0 && q.meanConfidence <= 1));
  };
  const language = doc.transcriptLanguage;
  const lang = typeof language === "object" && language !== null ? /** @type {Record<string, unknown>} */ (language) : null;
  const languageOk = language === undefined || language === null || (lang !== null && ((lang.mode === "auto" && !nonEmpty(lang.language)) || (lang.mode === "fixed" && nonEmpty(lang.language) && lang.language !== "auto")));
  const documentOk =
    languageOk &&
    doc.schemaVersion === "transcript.v1" &&
    nonEmpty(doc.jobId) &&
    nonEmpty(doc.episodeId) &&
    Array.isArray(doc.cues) &&
    ["deepinfra", "cloudflare", "openrouter", "mixed"].includes(/** @type {string} */ (doc.provider)) &&
    nonEmpty(doc.model) &&
    nonEmpty(doc.versionContract) &&
    doc.attempt !== undefined &&
    doc.attempt !== null &&
    nonNegative(doc.attempt) &&
    doc.measuredAudioMs !== undefined &&
    doc.measuredAudioMs !== null &&
    nonNegative(doc.measuredAudioMs) &&
    (doc.language === undefined || doc.language === null || nonEmpty(doc.language)) &&
    (doc.providerObservedDurationMs === undefined || doc.providerObservedDurationMs === null || nonNegative(doc.providerObservedDurationMs)) &&
    (doc.billedAudioSeconds === undefined || doc.billedAudioSeconds === null || nonNegative(doc.billedAudioSeconds)) &&
    (doc.providerReportedCostUsd === undefined || doc.providerReportedCostUsd === null || nonNegative(doc.providerReportedCostUsd)) &&
    qualityOk(doc.quality);
  if (!documentOk) return null;
  const cues = /** @type {unknown[]} */ (doc.cues);
  for (const cue of cues) {
    if (cue === null || typeof cue !== "object") return null;
    const c = /** @type {Record<string, unknown>} */ (cue);
    const who = c.identity;
    if (who === null || typeof who !== "object") return null;
    const identity = /** @type {Record<string, unknown>} */ (who);
    const identityOk = identity.kind === "participant" && nonEmpty(identity.participantRef) && typeof identity.participantGeneration === "number" && identity.participantGeneration >= 1 && nonEmpty(identity.trackId) && nonEmpty(identity.trackEpoch);
    const cueOk =
      nonNegative(c.startMs) &&
      typeof c.endMs === "number" &&
      c.endMs > /** @type {number} */ (c.startMs) &&
      identityOk &&
      c.trackClass === "microphone" &&
      nonEmpty(c.text) &&
      typeof c.overlap === "boolean" &&
      ["deepinfra", "cloudflare", "openrouter"].includes(/** @type {string} */ (c.provider)) &&
      nonEmpty(c.model) &&
      nonEmpty(c.versionContract) &&
      c.attempt !== undefined &&
      c.attempt !== null &&
      nonNegative(c.attempt) &&
      qualityOk(c.quality) &&
      (c.displayNameSnapshot === undefined || c.displayNameSnapshot === null || nonEmpty(c.displayNameSnapshot));
    if (!cueOk) return null;
  }
  return { cues: cues.length, provider: typeof doc.provider === "string" ? doc.provider : null };
}

/** S3 URI encoding: RFC 3986 unreserved characters stay, everything else is percent-encoded, slashes separate segments. */
const s3Encode = (/** @type {string} */ key) =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

/**
 * A SigV4 GET on an R2 (S3-compatible) object, built with `node:crypto` alone — no SDK. Returns the HTTP status, body bytes
 * and the content type the store reports, or status 0 when the request itself failed.
 * @param {{ endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string }} remote
 * @param {string} key
 * @returns {Promise<{ status: number, bytes: Buffer | null, contentType: string | null }>}
 */
async function sigv4Get(remote, key) {
  const host = new URL(remote.endpoint).host;
  const path = `/${remote.bucket}/${s3Encode(key)}`;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const date = stamp.slice(0, 8);
  const emptySha = createHash("sha256").update("").digest("hex");
  const region = "auto";
  const scope = `${date}/${region}/s3/aws4_request`;
  const canonical = `GET\n${path}\n\nhost:${host}\nx-amz-content-sha256:${emptySha}\nx-amz-date:${stamp}\n\nhost;x-amz-content-sha256;x-amz-date\n${emptySha}`;
  const toSign = `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  const hmac = (/** @type {string | Buffer} */ secret, /** @type {string} */ data) => createHmac("sha256", secret).update(data).digest();
  const signing = hmac(hmac(hmac(hmac(`AWS4${remote.secretAccessKey}`, date), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signing).update(toSign).digest("hex");
  const response = await fetch(`${remote.endpoint.replace(/\/$/, "")}${path}`, {
    headers: {
      "x-amz-content-sha256": emptySha,
      "x-amz-date": stamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${remote.accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (response === null) return { status: 0, bytes: null, contentType: null };
  const bytes = response.status === 200 ? Buffer.from(await response.arrayBuffer()) : null;
  return { status: response.status, bytes, contentType: response.headers.get("content-type") };
}

/**
 * One object read: the host artifact directory under `CHALK_DIAGNOSE_R2_DIR`, or the SigV4 GET otherwise. Keys are storage
 * paths; anything that escapes the root (`/`, `..`) is refused before it reaches the filesystem, the same constraint the
 * artifact_key column enforces. On disk the content type is inferred from the extension — the artifact store marks transcript
 * documents `application/json` and `.json` is the only shape this slice stores.
 * @param {{ dir?: string, remote?: { endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string } }} store
 * @param {string} key
 * @returns {Promise<{ status: number, bytes: Buffer | null, contentType: string | null }>}
 */
async function readR2(store, key) {
  if (/^\/|(^|\/)\.\.?(\/|$)|\/\//.test(key)) return { status: 0, bytes: null, contentType: null };
  if (store.dir !== undefined) {
    try {
      const bytes = readFileSync(join(store.dir, key));
      return { status: 200, bytes, contentType: key.endsWith(".json") ? "application/json" : "application/octet-stream" };
    } catch (error) {
      return /** @type {{ code?: unknown }} */ (error).code === "ENOENT" ? { status: 404, bytes: null, contentType: null } : { status: 0, bytes: null, contentType: null };
    }
  }
  return sigv4Get(/** @type {NonNullable<typeof store.remote>} */ (store.remote), key);
}

/**
 * The `transcript.r2.object` observation's value in the registry's vocabulary, computed in the order
 * `transcript.unreadable` names: 404 is `not_found`; a size, sha, content-type or validation mismatch gets its own result; a
 * 200 that parses as a valid `transcript.v1` document is `ok`. A request that never answered is `error`.
 * @param {{ status: number, bytes: Buffer | null, contentType: string | null }} answer
 * @param {Row} transcript the transcriptions row — artifact columns only, the key never leaves the reader
 * @param {number} at
 */
function r2Value(answer, transcript, at) {
  if (answer.status === 404) return { transcript_r2_result: "not_found", est_server_ms: at };
  if (answer.status !== 200 || answer.bytes === null) return { transcript_r2_result: "error", est_server_ms: at };
  /** @type {Record<string, string | number | boolean>} */
  const value = { transcript_r2_result: "error", transcript_size_bytes: answer.bytes.length, est_server_ms: at };
  const artifactSize = timeOf(transcript, "artifact_size");
  const artifactSha = typeof transcript.artifact_sha256 === "string" ? transcript.artifact_sha256 : null;
  const artifactType = typeof transcript.artifact_content_type === "string" ? transcript.artifact_content_type : null;
  if (artifactSha !== null) value.transcript_sha_match = createHash("sha256").update(answer.bytes).digest("hex") === artifactSha;
  let parsed = null;
  try {
    parsed = JSON.parse(answer.bytes.toString("utf8"));
  } catch {
    parsed = null;
  }
  const valid = parsed === null ? null : validateDocument(parsed);
  if (valid !== null) {
    value.transcript_cue_count = valid.cues;
    if (valid.provider !== null) value.transcript_provider = valid.provider;
  }
  value.transcript_r2_result =
    artifactSize !== null && answer.bytes.length !== artifactSize
      ? "size_mismatch"
      : artifactSha !== null && value.transcript_sha_match === false
        ? "sha_mismatch"
        : artifactType !== null && answer.contentType !== null && (answer.contentType.split(";")[0] ?? "").trim() !== artifactType
          ? "type_mismatch"
          : valid === null
            ? "invalid"
            : "ok";
  return value;
}

/* -------------------------------------------------------------------------- */
/* observations over db rows                                                   */
/* -------------------------------------------------------------------------- */

/** A db/r2 observation's id: deterministic per (event, row key), so re-reads keep one id and history stays stable.
 * Canonical event ids are bare uuids — the `ev_` prefix is the handle's, added at render. */
const stableId = (/** @type {string} */ seed) => {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * One db observation for a registered fact's db event. Only the event's declared fields reach the value — anything else the
 * row carried (artifact keys, error details, lease tokens) is dropped here even if the SQL selected it for the reader's own
 * use.
 * @param {{ event: string, fact: string, key: string, subject: Subject, window: { from_ms: number, to_ms: number }, claim: string, value: Record<string, string | number | boolean>, query: string, at: number, source?: string }} input
 * @returns {Observation}
 */
function dbObservation({ event, fact, key, subject, window, claim, value, query, at, source = "db" }) {
  const entry = (BY_EVENT.get(event) ?? []).find((candidate) => candidate.fact === fact && candidate.source === source);
  if (entry === undefined) throw new EvidenceError(`registry names no ${source} event ${event} for ${fact}`);
  /** @type {Record<string, string | number | boolean>} */
  const declared = {};
  for (const [name, fieldValue] of Object.entries(value)) if (entry.fields.has(name)) declared[name] = fieldValue;
  return observation({
    id: stableId(`${source}|${event}|${key}`),
    fact,
    source: /** @type {Observation["source"]} */ (source),
    origin: origin.measured(source),
    subject,
    window,
    claim,
    value: { ...declared, est_server_ms: at },
    failure: entry.failure_claims.includes(claim),
    query,
  });
}

/**
 * A db row's life as an observation window: from its start to the instant the db answered. The kernel matches an observation
 * to a check by overlap with the item's judged window, and the rules use `window.to_ms` as their "now", so every checker-read
 * row reports its current state through the read — a Recording that completed before its transcription job was created still
 * overlaps the job's window and witnesses it. `to_ms` never precedes `from_ms` even on a manually rewritten row.
 */
const lifeWindow = (/** @type {Row} */ row, /** @type {number} */ at, /** @type {string} */ startField = "created_ms") => {
  const from_ms = timeOf(row, startField) ?? at;
  return { from_ms, to_ms: Math.max(at, from_ms) };
};

/** The Episode's transcription mode, read the way apps/api/db/queries/episode_talk_time.sql reads it. */
const transcriptModeOf = (/** @type {Row | null} */ episode) => {
  const mode = episode?.transcript_mode;
  return mode === "on_demand" || mode === "automatic" ? mode : "disabled";
};

/* -------------------------------------------------------------------------- */
/* db reads                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The db reads behind one job item: the `artifact_jobs` row the item is — or the Recording's `recording_jobs` render row when
 * no artifact job carries the uuid — plus its transcription, recording, preparation and attempt rows, the Episode's mode, and
 * the tenant's name. `at` is the instant the db answers came back: the watermark's `complete_to_ms` and the `est_server_ms` of
 * every observation this read produces.
 * @param {Awaited<ReturnType<typeof resolveDevConfig>>} config
 * @param {string} id
 */
async function jobDbReads(config, id) {
  const job = await readDb(
    config,
    `select row_to_json(j) from (select j.id, j.tenant_id, j.episode_id, j.recording_id, j.transcript_id, j.chunk_id, j.artifact_kind, j.state, j.error_code, j.attempt_count, j.attempt_limit, ${msOf("j.terminal_at")} as terminal_ms, ${msOf("j.available_at")} as available_ms, ${msOf("j.lease_expires_at")} as lease_expiry_ms, ${msOf("j.created_at")} as created_ms, ${msOf("j.updated_at")} as updated_ms, (select count(*)::int from artifact_jobs s where s.transcript_id = j.transcript_id and s.state in (${OPEN_JOB_STATES})) as open_jobs, (select count(*)::int from artifact_jobs s where s.transcript_id = j.transcript_id and s.state = 'dead_letter') as dead_letter_jobs, (j.id = (select s.id from artifact_jobs s where s.transcript_id = j.transcript_id order by s.created_at desc, s.id desc limit 1)) as latest_job, (select row_to_json(r) from (select s.artifact_kind, s.error_code from artifact_jobs s where s.transcript_id = j.transcript_id and s.attempt_count > 1 order by s.created_at, s.id limit 1) r) as first_retry from artifact_jobs j where j.id = '${id}') j`,
  );
  const render =
    job === null
      ? await readDb(
          config,
          `select row_to_json(p) from (select p.id, p.tenant_id, p.episode_id, p.recording_id, p.kind, p.state, p.error_code, p.attempt_count, ${msOf("p.terminal_at")} as terminal_ms, ${msOf("p.available_at")} as available_ms, ${msOf("p.created_at")} as created_ms, ${msOf("p.updated_at")} as updated_ms from recording_jobs p where p.id = '${id}') p`,
        )
      : null;
  if (job === null && render === null) return null;
  const at = Date.now();
  const row = job ?? render;
  const recordingId = /** @type {string | null} */ (row.recording_id);
  const transcriptId = job === null ? null : /** @type {string | null} */ (job.transcript_id);
  const attemptWhere = job !== null && job.artifact_kind === "transcription_chunk" && typeof job.chunk_id === "string" ? `a.chunk_id = '${job.chunk_id}'` : transcriptId !== null ? `a.transcript_id = '${transcriptId}'` : null;
  const [transcript, recording, prep, episode, attempts, tenant, version] = await Promise.all([
    transcriptId !== null ? readDb(config, transcriptionBy(`t.id = '${transcriptId}'`)) : recordingId !== null ? readDb(config, transcriptionBy(`t.recording_id = '${recordingId}'`)) : Promise.resolve(null),
    recordingId !== null ? readDb(config, `select row_to_json(r) from (select r.id, r.status, ${msOf("r.completed_at")} as completed_ms, ${msOf("r.updated_at")} as updated_ms, ${msOf("r.created_at")} as created_ms from recordings r where r.id = '${recordingId}') r`) : Promise.resolve(null),
    recordingId !== null
      ? readDb(
          config,
          `select row_to_json(p) from (select p.id, p.recording_id, p.state, p.error_code, p.attempt_count, ${msOf("p.terminal_at")} as terminal_ms, ${msOf("p.available_at")} as available_ms, ${msOf("p.lease_expires_at")} as lease_expiry_ms, ${msOf("p.created_at")} as created_ms, ${msOf("p.updated_at")} as updated_ms from recording_jobs p where p.recording_id = '${recordingId}' and p.kind = 'transcription' order by p.created_at desc, p.id desc limit 1) p`,
        )
      : Promise.resolve(null),
    typeof row.episode_id === "string"
      ? readDb(
          config,
          `select row_to_json(e) from (select e.id, e.tenant_id, e.space_id, e.status, e.end_reason, case when e.config_snapshot #>> '{artifact_policy,transcription,mode}' in ('on_demand','automatic') then e.config_snapshot #>> '{artifact_policy,transcription,mode}' else 'disabled' end as transcript_mode, ${msOf("e.started_at")} as started_ms, ${msOf("e.ended_at")} as ended_ms, ${msOf("e.created_at")} as created_ms from episodes e where e.id = '${row.episode_id}') e`,
        )
      : Promise.resolve(null),
    attemptWhere !== null
      ? readDb(
          config,
          `select coalesce(json_agg(row_to_json(a) order by a.chunk_index, a.attempt), '[]'::json) from (select a.id, a.chunk_id, c.chunk_index, a.generation, a.attempt, a.provider, a.error_code, a.provider_observed_duration_ms as observed_ms, a.measured_audio_ms as speech_ms, ${msOf("a.finished_at")} as finished_ms, ${msOf("a.started_at")} as started_ms, a.state from transcription_attempts a join transcript_chunks c on c.id = a.chunk_id where ${attemptWhere}) a`,
        )
      : Promise.resolve([]),
    readDb(config, `select row_to_json(t) from (select t.id, t.name from tenants t where t.id = '${row.tenant_id}') t`),
    readDb(config, "select row_to_json(v) from (select max(version_id) as version from goose_db_version) v").then(
      (result) => (result === null || typeof result !== "object" ? null : (result.version ?? null)),
      () => null,
    ),
  ]);
  return { job, render, transcript, recording, prep, episode, attempts: /** @type {Row[]} */ (attempts ?? []), tenant, version, at };
}

/**
 * The db reads behind one episode item: the Episode, every Recording, each Recording's transcription and its latest
 * transcription preparation row. The talk-time recompute replays `transcriptInProgress` over them the way
 * apps/api/internal/talktime/service.go does — including the dead-Recording counting the spec keeps.
 * @param {Awaited<ReturnType<typeof resolveDevConfig>>} config
 * @param {string} id
 */
async function episodeDbReads(config, id) {
  const episode = await readDb(
    config,
    `select row_to_json(e) from (select e.id, e.tenant_id, e.space_id, e.status, e.end_reason, case when e.config_snapshot #>> '{artifact_policy,transcription,mode}' in ('on_demand','automatic') then e.config_snapshot #>> '{artifact_policy,transcription,mode}' else 'disabled' end as transcript_mode, ${msOf("e.started_at")} as started_ms, ${msOf("e.ended_at")} as ended_ms, ${msOf("e.created_at")} as created_ms from episodes e where e.id = '${id}') e`,
  );
  if (episode === null) return null;
  const at = Date.now();
  const [recordings, transcriptions, preps, tenant, version] = await Promise.all([
    readDb(
      config,
      `select coalesce(json_agg(row_to_json(r) order by r.created_ms, r.id), '[]'::json) from (select r.id, r.status, ${msOf("r.completed_at")} as completed_ms, ${msOf("r.updated_at")} as updated_ms, ${msOf("r.created_at")} as created_ms from recordings r where r.episode_id = '${id}' and r.tenant_id = '${episode.tenant_id}') r`,
    ),
    readDb(config, transcriptionsBy(`t.episode_id = '${id}' and t.tenant_id = '${episode.tenant_id}'`)),
    readDb(
      config,
      `select coalesce(json_agg(row_to_json(p) order by p.recording_id), '[]'::json) from (select distinct on (p.recording_id) p.id, p.recording_id, p.state, p.error_code, p.attempt_count, ${msOf("p.terminal_at")} as terminal_ms, ${msOf("p.available_at")} as available_ms, ${msOf("p.lease_expires_at")} as lease_expiry_ms, ${msOf("p.created_at")} as created_ms, ${msOf("p.updated_at")} as updated_ms from recording_jobs p where p.episode_id = '${id}' and p.tenant_id = '${episode.tenant_id}' and p.kind = 'transcription' order by p.recording_id, p.created_at desc, p.id desc) p`,
    ),
    readDb(config, `select row_to_json(t) from (select t.id, t.name from tenants t where t.id = '${episode.tenant_id}') t`),
    readDb(config, "select row_to_json(v) from (select max(version_id) as version from goose_db_version) v").then(
      (result) => (result === null || typeof result !== "object" ? null : (result.version ?? null)),
      () => null,
    ),
  ]);
  return { episode, recordings: /** @type {Row[]} */ (recordings ?? []), transcriptions: /** @type {Row[]} */ (transcriptions ?? []), preps: /** @type {Row[]} */ (preps ?? []), tenant, version, at };
}

/* -------------------------------------------------------------------------- */
/* per-item evidence                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One source's watermark for the item: subject `*` (one stream serves the whole item), `emits` the registry facts the build
 * can emit on that source, `complete_to_ms` the moment its read finished — null when the source was never read.
 * @param {string} source
 * @param {number | null} complete_to_ms
 * @param {readonly EvidenceGap[]} gaps
 * @param {string} build
 * @returns {Watermark}
 */
const sourceWatermark = (source, complete_to_ms, gaps, build) => ({ source, subject: ITEM, complete_to_ms, evidence_gaps: [...gaps], emits: EMITS.get(source) ?? [], build });

/**
 * The item's log observations and the `lambda` evidence gap. Only rows that can bind to the item are kept — a row naming
 * another job, or no job at all, would seal into the bundle as `unbound` and read the coverage partial without witnessing
 * anything. For `lambda`, a job the db shows claimed (`attempt_count`, a lease, `leased` state) whose terminal op never
 * reached the log — while the dispatcher's own activity rows show work ran — is the open gap the `attempt_lost` symptom
 * names: the source's records stop mid-flight.
 * @param {"job" | "episode"} kind
 * @param {{ id: string, tenant: string, episode: string }} item
 * @param {{ job?: { artifact_kind: string, attempt_count: number, lease_expiry_ms: number | null, state: string, created_ms: number } }} ctx
 * @param {{ api?: LogRead, lambda?: LogRead }} logs
 */
function itemLogEvidence(kind, item, ctx, logs) {
  /** @type {Observation[]} */
  const observations = [];
  /** @type {string[]} */
  const notes = [];
  for (const log of [logs.api, logs.lambda]) {
    if (log === undefined) continue;
    /** @type {Observation[]} */
    const kept = [];
    let unbound = 0;
    for (const entry of log.rows) {
      const raw = entry.raw;
      if (kind === "job") {
        if (raw.job_id !== item.id) continue;
        if (typeof raw.tenant_id === "string" && raw.tenant_id !== item.tenant) continue;
        kept.push(...logObservations(entry, log, { tenant: item.tenant, episode: typeof raw.episode_id === "string" ? raw.episode_id : item.episode, job: item.id }));
      } else {
        if (raw.episode_id !== item.id) continue;
        if (typeof raw.tenant_id === "string" && raw.tenant_id !== item.tenant) continue;
        // A row naming a participant binds to a seat the seeded item never declares, so it could only be unbound.
        if (typeof raw.participant_id === "string" || typeof raw.media_connection_id === "string") {
          unbound += 1;
          continue;
        }
        /** @type {Subject} */
        const subject = { tenant: item.tenant, episode: item.id };
        if (typeof raw.job_id === "string") subject.job = raw.job_id;
        kept.push(...logObservations(entry, log, subject));
      }
    }
    observations.push(...kept);
    notes.push(`${log.source}: kept ${kept.length} of ${log.rows.length} parsed rows from ${basename(log.file)}${log.skipped > 0 ? ` (${log.skipped} unparsable lines skipped)` : ""}${unbound > 0 ? `, dropped ${unbound} that could never bind` : ""}`);
  }

  /** @type {EvidenceGap[]} */
  const gaps = [];
  const job = ctx.job;
  if (kind === "job" && job !== undefined && logs.lambda !== undefined) {
    const terminal = job.artifact_kind === "transcription_finalize" ? "transcript.finalize" : job.artifact_kind === "transcription_chunk" ? "transcript.chunk" : null;
    if (terminal !== null) {
      const claimed = job.attempt_count > 0 || job.lease_expiry_ms !== null || job.state === "leased";
      const hasTerminal = logs.lambda.rows.some(({ raw }) => eventNameOf(raw) === terminal && raw.job_id === item.id);
      const activity = logs.lambda.rows
        .filter(({ raw }) => (plainNameOf(raw) === "dispatcher_claimed" && (typeof raw.count !== "number" || raw.count > 0)) || eventNameOf(raw) === "transcript.dispatcher.invoke")
        .map(({ raw }) => rowTime(raw, /** @type {LogRead} */ (logs.lambda).mtime_ms))
        .filter((at) => at >= job.created_ms);
      if (claimed && !hasTerminal && activity.length > 0) {
        gaps.push({ from_ms: Math.max(...activity), to_ms: null, reason: `the dispatcher claimed work but no ${terminal} terminal for this job reached the log` });
      }
    }
  }
  return { observations, gaps, notes };
}

/* -------------------------------------------------------------------------- */
/* buildWorld                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The r2 store the environment names: the host artifact directory, the four `CHALK_DIAGNOSE_R2_*` variables, or nothing — in
 * which case the r2 watermark reads `complete_to_ms: null` and no readback happens. A partial remote configuration is a
 * caller error, never silently unread.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ dir?: string, remote?: { endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string } }}
 */
function r2Store(env) {
  if (typeof env.CHALK_DIAGNOSE_R2_DIR === "string" && env.CHALK_DIAGNOSE_R2_DIR !== "") return { dir: env.CHALK_DIAGNOSE_R2_DIR };
  const { CHALK_DIAGNOSE_R2_ENDPOINT: endpoint, CHALK_DIAGNOSE_R2_BUCKET: bucket, CHALK_DIAGNOSE_R2_ACCESS_KEY_ID: accessKeyId, CHALK_DIAGNOSE_R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  const present = [endpoint, bucket, accessKeyId, secretAccessKey].filter((value) => typeof value === "string" && value !== "");
  if (present.length === 0) return {};
  if (present.length !== 4) throw new EvidenceError("CHALK_DIAGNOSE_R2_* is partially set: the readback needs ENDPOINT, BUCKET, ACCESS_KEY_ID and SECRET_ACCESS_KEY, or CHALK_DIAGNOSE_R2_DIR");
  return { remote: { endpoint: /** @type {string} */ (endpoint), bucket: /** @type {string} */ (bucket), accessKeyId: /** @type {string} */ (accessKeyId), secretAccessKey: /** @type {string} */ (secretAccessKey) } };
}

/** The schema version the dev stack's migrations left on `goose_db_version`, for the db watermark's `build` label. */
const buildLabel = (/** @type {unknown} */ version) => (typeof version === "number" || typeof version === "string" ? `db goose ${version}` : "db dev");

/**
 * The World of one transcription item: a `job` (an `artifact_jobs` row, or the Recording's `recording_jobs` render row) or an
 * `episode`. The db is read through the dev container; `api` and `lambda` come from the dev logs when
 * `CHALK_DIAGNOSE_LOCAL_LOGS` names the directory; `r2` is read back from `CHALK_DIAGNOSE_R2_DIR` or the
 * `CHALK_DIAGNOSE_R2_*` SigV4 target. Anything not read stays not read on its watermark — the kernel turns that into gaps,
 * never absence.
 * @param {{ kind: "job" | "episode", id: string }} item
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ world: World, notes: string[] }>}
 */
export async function buildWorld(item, env = process.env) {
  if (!UUID.test(item.id)) throw new EvidenceError(`${item.kind} needs a uuid, got ${JSON.stringify(item.id.slice(0, 40))}`);
  const config = resolveDevConfig({ env });
  const notes = [];

  const logsDir = typeof env.CHALK_DIAGNOSE_LOCAL_LOGS === "string" && env.CHALK_DIAGNOSE_LOCAL_LOGS !== "" ? env.CHALK_DIAGNOSE_LOCAL_LOGS : null;
  /** @type {{ api?: LogRead, lambda?: LogRead }} */
  const logs = {};
  if (logsDir === null) {
    notes.push("CHALK_DIAGNOSE_LOCAL_LOGS is not set: api and lambda are not read");
  } else {
    for (const [source, file] of /** @type {const} */ ([
      ["api", "api.log"],
      ["lambda", "dispatcher.jsonl"],
    ])) {
      try {
        logs[source] = loadLog(join(logsDir, file), source);
      } catch (error) {
        if (/** @type {{ code?: unknown }} */ (error).code !== "ENOENT") throw error;
        notes.push(`${source}: ${file} is missing under ${logsDir}, so the source is not read`);
      }
    }
  }
  const store = r2Store(env);
  if (store.dir === undefined && store.remote === undefined) notes.push("no CHALK_DIAGNOSE_R2_DIR or CHALK_DIAGNOSE_R2_* configured: r2 is not read");

  if (item.kind === "job") {
    const read = await jobDbReads(config, item.id);
    if (read === null) throw new EvidenceError(`no artifact_jobs or recording_jobs row for ${item.id}`);
    return jobWorld(item.id, read, logs, store, notes);
  }
  const read = await episodeDbReads(config, item.id);
  if (read === null) throw new EvidenceError(`no episodes row for ${item.id}`);
  return episodeWorld(item.id, read, logs, notes);
}

/**
 * @param {string} id
 * @param {NonNullable<Awaited<ReturnType<typeof jobDbReads>>>} read
 * @param {{ api?: LogRead, lambda?: LogRead }} logs
 * @param {ReturnType<typeof r2Store>} store
 * @param {string[]} notes
 * @returns {Promise<{ world: World, notes: string[] }>}
 */
async function jobWorld(id, read, logs, store, notes) {
  const { job, render, transcript, recording, prep, episode, attempts, tenant, version, at } = read;
  // The world's as-of is the least-covered instant: open items are judged up to `asof_ms`, so it is the earliest point the
  // read sources all reached, never a later now. The r2 readback runs after this and can only cover more.
  const asof_ms = Math.min(at, ...[logs.api?.read_ms, logs.lambda?.read_ms].filter((stamp) => stamp !== undefined));
  /** @type {Observation[]} */
  const observations = [];
  const row = /** @type {Row} */ (job ?? render);
  const tenantId = /** @type {string} */ (row.tenant_id);
  const episodeId = /** @type {string} */ (row.episode_id);
  const recordingId = typeof row.recording_id === "string" ? row.recording_id : null;
  const transcriptId = job !== null && typeof job.transcript_id === "string" ? job.transcript_id : null;
  const isRender = job === null;
  const jobKind = /** @type {string} */ (isRender ? render.kind : job.artifact_kind);
  const subject = { tenant: tenantId, episode: episodeId, job: id };
  const mode = transcriptModeOf(episode);
  const terminal = timeOf(row, "terminal_ms");

  // A job row that has not reached a terminal state is an open item: it is judged up to `asof_ms` and can never be healthy
  // yet. A closed item's checks read to `terminal + settle` — every transcript rule declares settle_ms 60 s — and the item's
  // own row observation ends at most there, because rules cite `jobRow.window.to_ms` as the `asof` of a claimed-absence
  // window that must stay inside what the check read.
  const horizon = terminal === null ? asof_ms : Math.min(at, terminal + 60_000);
  /** @type {Declaration} */
  const declaration = { kind: "job", id, tenant: tenantId, episode: episodeId, job_kind: jobKind, window: { from_ms: timeOf(row, "created_ms") ?? asof_ms, to_ms: terminal } };

  if (!isRender) {
    /** @type {Record<string, string | number | boolean>} */
    const jobValue = {
      job_id: id,
      transcript_job_state: /** @type {string} */ (row.state),
      transcript_job_kind: /** @type {string} */ (row.artifact_kind),
      transcript_attempt_count: /** @type {number} */ (row.attempt_count),
      transcript_attempt_limit: /** @type {number} */ (row.attempt_limit),
      transcript_created_ms: /** @type {number} */ (row.created_ms),
      transcript_updated_ms: /** @type {number} */ (row.updated_ms),
      transcript_latest_job: row.latest_job === true,
      transcript_open_jobs: /** @type {number} */ (row.open_jobs),
      transcript_dead_letter_jobs: /** @type {number} */ (row.dead_letter_jobs),
    };
    if (timeOf(row, "available_ms") !== null) jobValue.transcript_available_ms = /** @type {number} */ (row.available_ms);
    if (typeof row.error_code === "string") jobValue.transcript_error_code = row.error_code;
    if (timeOf(row, "terminal_ms") !== null) jobValue.transcript_terminal_ms = /** @type {number} */ (row.terminal_ms);
    if (timeOf(row, "lease_expiry_ms") !== null) jobValue.transcript_lease_expiry_ms = /** @type {number} */ (row.lease_expiry_ms);
    const retry = row.first_retry;
    if (retry !== null && typeof retry === "object") {
      jobValue.transcript_first_retry_kind = /** @type {string} */ (/** @type {Row} */ (retry).artifact_kind);
      if (typeof (/** @type {Row} */ (retry).error_code) === "string") jobValue.transcript_first_retry_code = /** @type {string} */ (/** @type {Row} */ (retry).error_code);
    }
    observations.push(
      dbObservation({
        event: "transcript.db.job",
        fact: "transcript.job_state",
        key: id,
        subject,
        window: { from_ms: /** @type {number} */ (declaration.window.from_ms), to_ms: Math.max(horizon, /** @type {number} */ (declaration.window.from_ms)) },
        claim: /** @type {string} */ (row.state),
        value: jobValue,
        query: `psql -c "select * from artifact_jobs where id = '${id}'"`,
        at,
      }),
    );
    // The item is no Recording export job, so `transcript.render` (a required witness of `transcript.stuck`) is the
    // registry's `none` claim: the reader looked for the item's own recording_jobs row and it is not there.
    observations.push(
      dbObservation({
        event: "transcript.db.render",
        fact: "transcript.render",
        key: `none:${id}`,
        subject,
        window: { from_ms: /** @type {number} */ (declaration.window.from_ms), to_ms: at },
        claim: "none",
        value: { job_id: id, transcript_prep_state: "none" },
        query: `psql -c "select * from recording_jobs where id = '${id}'"`,
        at,
      }),
    );
  } else {
    /** @type {Record<string, string | number | boolean>} */
    const renderValue = { job_id: id, transcript_prep_state: /** @type {string} */ (row.state), transcript_created_ms: /** @type {number} */ (row.created_ms) };
    if (timeOf(row, "available_ms") !== null) renderValue.transcript_available_ms = /** @type {number} */ (row.available_ms);
    if (timeOf(row, "terminal_ms") !== null) renderValue.transcript_terminal_ms = /** @type {number} */ (row.terminal_ms);
    observations.push(
      dbObservation({
        event: "transcript.db.render",
        fact: "transcript.render",
        key: id,
        subject,
        window: { from_ms: /** @type {number} */ (declaration.window.from_ms), to_ms: Math.max(horizon, /** @type {number} */ (declaration.window.from_ms)) },
        claim: /** @type {string} */ (row.state),
        value: renderValue,
        query: `psql -c "select * from recording_jobs where id = '${id}'"`,
        at,
      }),
    );
    // The item is no artifact_jobs row, so `transcript.job_state` (a required witness of `transcript.stuck`) is the
    // registry's `none` claim rather than a fabricated job row.
    observations.push(
      dbObservation({
        event: "transcript.db.job",
        fact: "transcript.job_state",
        key: `none:${id}`,
        subject,
        window: { from_ms: /** @type {number} */ (declaration.window.from_ms), to_ms: at },
        claim: "none",
        value: { job_id: id, transcript_job_state: "none" },
        query: `psql -c "select * from artifact_jobs where id = '${id}'"`,
        at,
      }),
    );
  }

  if (transcript !== null) {
    /** @type {Record<string, string | number | boolean>} */
    const transcriptValue = {
      transcript_exists: true,
      transcript_state: /** @type {string} */ (transcript.status),
      transcript_deleted: transcript.deleted === true,
      transcript_created_ms: /** @type {number} */ (transcript.created_ms),
      transcript_updated_ms: /** @type {number} */ (transcript.updated_ms),
      transcript_artifact_set: transcript.artifact_set === true,
      transcript_sha_set: transcript.sha_set === true,
      transcript_generation: /** @type {number} */ (transcript.generation),
      transcript_mode: mode,
      transcript_open_jobs: /** @type {number} */ (transcript.open_jobs),
      transcript_dead_letter_jobs: /** @type {number} */ (transcript.dead_letter_jobs),
    };
    if (recordingId !== null) transcriptValue.recording_id = recordingId;
    if (timeOf(transcript, "completed_ms") !== null) transcriptValue.transcript_completed_ms = /** @type {number} */ (transcript.completed_ms);
    observations.push(
      dbObservation({
        event: "transcript.db.transcription",
        fact: "transcript.row",
        key: /** @type {string} */ (transcript.id),
        subject,
        window: lifeWindow(transcript, at),
        claim: /** @type {string} */ (transcript.status),
        value: transcriptValue,
        query: `psql -c "select * from transcriptions where id = '${transcript.id}'"`,
        at,
      }),
    );
  } else {
    // The registry's `none` claim: a required witness of `transcript.stuck`, proven present so the reading is not merely
    // uncovered — `decideRender` reads `transcript_exists`/`claim "none"` as "the Recording has no transcription row".
    observations.push(
      dbObservation({
        event: "transcript.db.transcription",
        fact: "transcript.row",
        key: `none:${recordingId ?? id}`,
        subject,
        window: { from_ms: /** @type {number} */ (declaration.window.from_ms), to_ms: at },
        claim: "none",
        value: recordingId === null ? { transcript_exists: false, transcript_state: "none", transcript_mode: mode } : { recording_id: recordingId, transcript_exists: false, transcript_state: "none", transcript_mode: mode },
        query: `psql -c "select * from transcriptions where ${transcriptId !== null ? `id = '${transcriptId}'` : `recording_id = '${recordingId ?? ""}'`}"`,
        at,
      }),
    );
  }

  if (recording !== null) {
    /** @type {Record<string, string | number | boolean>} */
    const recordingValue = { transcript_recording_state: /** @type {string} */ (recording.status), transcript_mode: mode };
    if (recordingId !== null) recordingValue.recording_id = recordingId;
    if (timeOf(recording, "completed_ms") !== null) recordingValue.transcript_completed_ms = /** @type {number} */ (recording.completed_ms);
    observations.push(
      dbObservation({
        event: "transcript.db.recording",
        fact: "transcript.recording",
        key: recordingId ?? id,
        subject,
        window: lifeWindow(recording, at),
        claim: /** @type {string} */ (recording.status),
        value: recordingValue,
        query: `psql -c "select * from recordings where id = '${recordingId ?? ""}'"`,
        at,
      }),
    );
  } else {
    // A required witness of `transcript.stuck`: the Recording row behind the job is gone, so `none` stands in for it.
    observations.push(
      dbObservation({
        event: "transcript.db.recording",
        fact: "transcript.recording",
        key: `none:${recordingId ?? id}`,
        subject,
        window: { from_ms: /** @type {number} */ (declaration.window.from_ms), to_ms: at },
        claim: "none",
        value: recordingId === null ? { transcript_recording_state: "none", transcript_mode: mode } : { recording_id: recordingId, transcript_recording_state: "none", transcript_mode: mode },
        query: `psql -c "select * from recordings where id = '${recordingId ?? ""}'"`,
        at,
      }),
    );
  }

  {
    /** @type {Record<string, string | number | boolean>} */
    const prepValue = { transcript_exists: prep !== null };
    if (recordingId !== null) prepValue.recording_id = recordingId;
    if (prep !== null) {
      prepValue.transcript_prep_state = /** @type {string} */ (prep.state);
      prepValue.transcript_attempt_count = /** @type {number} */ (prep.attempt_count);
      if (timeOf(prep, "available_ms") !== null) prepValue.transcript_available_ms = /** @type {number} */ (prep.available_ms);
      if (typeof prep.error_code === "string") prepValue.transcript_error_code = prep.error_code;
      if (timeOf(prep, "terminal_ms") !== null) prepValue.transcript_terminal_ms = /** @type {number} */ (prep.terminal_ms);
      if (timeOf(prep, "lease_expiry_ms") !== null) prepValue.transcript_lease_expiry_ms = /** @type {number} */ (prep.lease_expiry_ms);
    }
    observations.push(
      dbObservation({
        event: "transcript.db.prep",
        fact: "transcript.prep",
        key: prep === null ? `none:${recordingId ?? id}` : /** @type {string} */ (prep.id),
        subject,
        window: prep === null ? { from_ms: /** @type {number} */ (declaration.window.from_ms), to_ms: at } : lifeWindow(prep, at),
        claim: prep === null ? "none" : /** @type {string} */ (prep.state),
        value: prepValue,
        query: `psql -c "select * from recording_jobs where recording_id = '${recordingId ?? ""}' and kind = 'transcription' order by created_at desc"`,
        at,
      }),
    );
  }

  for (const attempt of attempts) {
    /** @type {Record<string, string | number | boolean>} */
    const attemptValue = {
      transcript_attempt_state: /** @type {string} */ (attempt.state),
      attempt: /** @type {number} */ (attempt.attempt),
      transcript_generation: /** @type {number} */ (attempt.generation),
      transcript_chunk_index: /** @type {number} */ (attempt.chunk_index),
    };
    if (typeof attempt.provider === "string") attemptValue.transcript_provider = attempt.provider;
    if (timeOf(attempt, "observed_ms") !== null) attemptValue.transcript_observed_ms = /** @type {number} */ (attempt.observed_ms);
    if (timeOf(attempt, "speech_ms") !== null) attemptValue.transcript_speech_ms = /** @type {number} */ (attempt.speech_ms);
    if (typeof attempt.error_code === "string") attemptValue.transcript_error_code = attempt.error_code;
    if (timeOf(attempt, "finished_ms") !== null) attemptValue.transcript_finished_ms = /** @type {number} */ (attempt.finished_ms);
    observations.push(
      dbObservation({
        event: "transcript.db.attempt",
        fact: "transcript.attempts",
        key: /** @type {string} */ (attempt.id),
        subject,
        window: lifeWindow(attempt, at, "started_ms"),
        claim: /** @type {string} */ (attempt.state),
        value: attemptValue,
        query: `psql -c "select * from transcription_attempts where id = '${attempt.id}'"`,
        at,
      }),
    );
  }

  const logEvidence = itemLogEvidence(
    "job",
    { id, tenant: tenantId, episode: episodeId },
    { job: isRender ? undefined : { artifact_kind: jobKind, attempt_count: /** @type {number} */ (row.attempt_count), lease_expiry_ms: timeOf(row, "lease_expiry_ms"), state: /** @type {string} */ (row.state), created_ms: /** @type {number} */ (row.created_ms) } },
    logs,
  );
  observations.push(...logEvidence.observations);
  notes.push(...logEvidence.notes);
  notes.push(`db: read the ${isRender ? "recording_jobs" : "artifact_jobs"} row, ${transcript === null ? "no" : "one"} transcriptions row, ${attempts.length} transcription_attempts rows`);

  // The checker's r2 readback of the stored document, when the transcription stored an artifact and r2 is configured.
  let r2Complete = null;
  if (transcript !== null && typeof transcript.artifact_key === "string" && (store.dir !== undefined || store.remote !== undefined)) {
    const readAt = Date.now();
    const answer = await readR2(store, transcript.artifact_key);
    if (answer.status !== 0) {
      r2Complete = readAt;
      const value = r2Value(answer, transcript, readAt);
      observations.push(
        dbObservation({
          event: "transcript.r2.object",
          fact: "transcript.object",
          key: String(transcript.id),
          source: "r2",
          subject,
          // The stored document's life starts when the finalize wrote it: the readback's claim is about the object as it
          // stands now, and a point at read time would land outside the window of any job that ended over a settle ago.
          window: { from_ms: timeOf(transcript, "completed_ms") ?? /** @type {number} */ (transcript.created_ms), to_ms: readAt },
          claim: /** @type {string} */ (value.transcript_r2_result),
          value,
          query: `r2 get "$(psql -At -c "select artifact_key from transcriptions where id = '${transcript.id}'")"`,
          at: readAt,
        }),
      );
      notes.push(`r2: readback of the transcription's artifact answered ${value.transcript_r2_result} (status ${answer.status})`);
    } else {
      notes.push("r2: the readback request failed before an answer, so r2 is not read");
    }
  }

  /** @type {Watermark[]} */
  const watermarks = [
    sourceWatermark("db", at, [], buildLabel(version)),
    sourceWatermark("api", logs.api?.read_ms ?? null, [], "api dev"),
    sourceWatermark("lambda", logs.lambda?.read_ms ?? null, logEvidence.gaps, "lambda dev"),
    sourceWatermark("r2", r2Complete, [], store.dir !== undefined ? "r2 local" : store.remote !== undefined ? `r2 ${new URL(store.remote.endpoint).host}` : "r2 not read"),
  ];
  /** @type {Evidence} */
  const evidence = { observations, watermarks };
  return {
    world: {
      asof_ms,
      tenants: tenant === null ? [] : [{ id: tenantId, name: /** @type {string} */ (tenant.name), tz: "UTC" }],
      people: [],
      declarations: [declaration],
      sessions: [],
      evidence: { [id]: evidence },
      history: [],
    },
    notes,
  };
}

/**
 * @param {string} id
 * @param {NonNullable<Awaited<ReturnType<typeof episodeDbReads>>>} read
 * @param {{ api?: LogRead, lambda?: LogRead }} logs
 * @param {string[]} notes
 * @returns {Promise<{ world: World, notes: string[] }>}
 */
async function episodeWorld(id, read, logs, notes) {
  const { episode, recordings, transcriptions, preps, tenant, version, at } = read;
  // The world's as-of is the least-covered instant — a live Episode's checks read to `asof_ms`, so it is the earliest
  // point the read sources all reached, never a later now.
  const asof_ms = Math.min(at, ...[logs.api?.read_ms, logs.lambda?.read_ms].filter((stamp) => stamp !== undefined));
  const tenantId = /** @type {string} */ (episode.tenant_id);
  const mode = transcriptModeOf(episode);
  const subject = { tenant: tenantId, episode: id };
  // The judged window runs to `asof_ms`, not ended_at: transcription work (preparation, chunks, finalize, talk-time
  // serving) happens after the media end, and `talk_time_stuck` asks whether that work is dead *now* — the spec's
  // deadline math is `terminal_at <= asof - 10 min`. Ending the window at ended_at would make every post-end db row
  // unbindable and the check could never pass honestly. ended_ms stays in the `transcript.episode` fact for rules.
  /** @type {OpenWindow} */
  const window = { from_ms: timeOf(episode, "started_ms") ?? /** @type {number} */ (episode.created_ms), to_ms: asof_ms };
  /** @type {Declaration} */
  const declaration = { kind: "episode", id, tenant: tenantId, features: ["media", ...(episode.end_reason === "maximum_duration" ? ["time_limit"] : [])], window, seats: [] };

  /** @type {Observation[]} */
  const observations = [];
  observations.push(
    dbObservation({
      event: "transcript.db.episode",
      fact: "transcript.episode",
      key: id,
      subject,
      window: { from_ms: window.from_ms, to_ms: at },
      claim: mode,
      value: { episode_id: id, transcript_mode: mode, transcript_recordings: recordings.length },
      query: `psql -c "select id, config_snapshot #>> '{artifact_policy,transcription,mode}' from episodes where id = '${id}'"`,
      at,
    }),
  );

  const rowsByRecording = new Map(transcriptions.map((row) => [/** @type {string} */ (row.recording_id), row]));
  const prepsByRecording = new Map(preps.map((row) => [/** @type {string} */ (row.recording_id), row]));
  for (const recording of recordings) {
    const recordingId = /** @type {string} */ (recording.id);
    /** @type {Record<string, string | number | boolean>} */
    const recordingValue = { recording_id: recordingId, transcript_recording_state: /** @type {string} */ (recording.status), transcript_mode: mode };
    if (timeOf(recording, "completed_ms") !== null) recordingValue.transcript_completed_ms = /** @type {number} */ (recording.completed_ms);
    observations.push(
      dbObservation({
        event: "transcript.db.recording",
        fact: "transcript.recording",
        key: recordingId,
        subject,
        window: lifeWindow(recording, at),
        claim: /** @type {string} */ (recording.status),
        value: recordingValue,
        query: `psql -c "select * from recordings where id = '${recordingId}'"`,
        at,
      }),
    );
    const row = rowsByRecording.get(recordingId);
    /** @type {Record<string, string | number | boolean>} */
    const rowValue = { recording_id: recordingId, transcript_exists: row !== undefined, transcript_mode: mode };
    if (row !== undefined) {
      Object.assign(rowValue, {
        transcript_state: /** @type {string} */ (row.status),
        transcript_deleted: row.deleted === true,
        transcript_created_ms: /** @type {number} */ (row.created_ms),
        transcript_updated_ms: /** @type {number} */ (row.updated_ms),
        transcript_artifact_set: row.artifact_set === true,
        transcript_sha_set: row.sha_set === true,
        transcript_generation: /** @type {number} */ (row.generation),
        transcript_open_jobs: /** @type {number} */ (row.open_jobs),
        transcript_dead_letter_jobs: /** @type {number} */ (row.dead_letter_jobs),
      });
      if (timeOf(row, "completed_ms") !== null) rowValue.transcript_completed_ms = /** @type {number} */ (row.completed_ms);
    }
    observations.push(
      dbObservation({
        event: "transcript.db.transcription",
        fact: "transcript.row",
        key: row === undefined ? `none:${recordingId}` : /** @type {string} */ (row.id),
        subject,
        window: row === undefined ? { from_ms: timeOf(recording, "created_ms") ?? /** @type {number} */ (window.from_ms), to_ms: at } : lifeWindow(row, at),
        claim: row === undefined ? "none" : /** @type {string} */ (row.status),
        value: rowValue,
        query: `psql -c "select * from transcriptions where recording_id = '${recordingId}'"`,
        at,
      }),
    );
    const prep = prepsByRecording.get(recordingId);
    /** @type {Record<string, string | number | boolean>} */
    const prepValue = { recording_id: recordingId, transcript_exists: prep !== undefined };
    if (prep !== undefined) {
      Object.assign(prepValue, { transcript_prep_state: /** @type {string} */ (prep.state), transcript_attempt_count: /** @type {number} */ (prep.attempt_count) });
      if (timeOf(prep, "available_ms") !== null) prepValue.transcript_available_ms = /** @type {number} */ (prep.available_ms);
      if (typeof prep.error_code === "string") prepValue.transcript_error_code = prep.error_code;
      if (timeOf(prep, "terminal_ms") !== null) prepValue.transcript_terminal_ms = /** @type {number} */ (prep.terminal_ms);
      if (timeOf(prep, "lease_expiry_ms") !== null) prepValue.transcript_lease_expiry_ms = /** @type {number} */ (prep.lease_expiry_ms);
    }
    observations.push(
      dbObservation({
        event: "transcript.db.prep",
        fact: "transcript.prep",
        key: prep === undefined ? `none:${recordingId}` : /** @type {string} */ (prep.id),
        subject,
        window: prep === undefined ? { from_ms: timeOf(recording, "created_ms") ?? /** @type {number} */ (window.from_ms), to_ms: at } : lifeWindow(prep, at),
        claim: prep === undefined ? "none" : /** @type {string} */ (prep.state),
        value: prepValue,
        query: `psql -c "select * from recording_jobs where recording_id = '${recordingId}' and kind = 'transcription' order by created_at desc"`,
        at,
      }),
    );
  }

  // `transcriptInProgress` replayed from the stored rows — the db-side talk-time status, the independent witness of the served one.
  const talk = replayTalkTime(timeOf(episode, "ended_ms"), recordings, rowsByRecording, mode);
  observations.push(
    dbObservation({
      event: "transcript.db.talk",
      fact: "transcript.talk",
      key: `talk:${id}`,
      subject,
      // The recomputed status is the checker's current answer over the Episode's whole life, and a point at read time
      // would land outside the window of an Episode that ended over a settle ago.
      window: { from_ms: /** @type {number} */ (window.from_ms), to_ms: at },
      claim: talk.status,
      value: { episode_id: id, transcript_talk_status: talk.status, transcript_in_progress: talk.inProgress },
      query: `psql -c "select * from recordings where episode_id = '${id}'"`,
      at,
    }),
  );

  const logEvidence = itemLogEvidence("episode", { id, tenant: tenantId, episode: id }, {}, logs);
  observations.push(...logEvidence.observations);
  notes.push(...logEvidence.notes);
  notes.push(`db: read the episode, ${recordings.length} recordings, ${transcriptions.length} transcriptions, ${preps.length} latest prep rows`);

  /** @type {Watermark[]} */
  const watermarks = [sourceWatermark("db", at, [], buildLabel(version)), sourceWatermark("api", logs.api?.read_ms ?? null, [], "api dev"), sourceWatermark("lambda", logs.lambda?.read_ms ?? null, [], "lambda dev"), sourceWatermark("r2", null, [], "r2 not read")];
  /** @type {Evidence} */
  const evidence = { observations, watermarks };
  return {
    world: {
      asof_ms,
      tenants: tenant === null ? [] : [{ id: tenantId, name: /** @type {string} */ (tenant.name), tz: "UTC" }],
      people: [],
      declarations: [declaration],
      sessions: [],
      evidence: { [id]: evidence },
      history: [],
    },
    notes,
  };
}

/**
 * What talk-time's `Get` would answer from the stored rows alone: `live` while the Episode runs, `available` once a
 * Recording's document is ready, `transcript_pending` while a transcript can still arrive, else `no_transcript` — with the
 * count of in-progress Recordings `transcriptInProgress` gives (apps/api/internal/talktime/service.go:177). The db replay
 * can't open the document, so `available` counts `DocumentReady` rows: complete, not deleted, `application/json` artifact
 * inside the 25 MiB limit.
 * @param {number | null} ended the Episode's ended_at, ms
 * @param {readonly Row[]} recordings
 * @param {ReadonlyMap<string, Row>} rowsByRecording
 * @param {string} mode
 */
function replayTalkTime(ended, recordings, rowsByRecording, mode) {
  const automatic = mode === "automatic";
  const midFlight = new Set(["preparing", "transcribing", "verifying", "retryable_failure"]);
  let transcribed = 0;
  let inProgress = 0;
  for (const recording of recordings) {
    const row = rowsByRecording.get(/** @type {string} */ (recording.id));
    const documentReady = row !== undefined && row.status === "complete" && row.deleted !== true && typeof row.artifact_key === "string" && typeof row.artifact_size === "number" && row.artifact_size > 0 && row.artifact_size <= MAX_DOCUMENT_BYTES && row.artifact_content_type === "application/json";
    if (documentReady) {
      transcribed += 1;
      continue;
    }
    if (row !== undefined) {
      if (midFlight.has(/** @type {string} */ (row.status))) {
        if (row.deleted !== true) inProgress += 1;
      } else if (row.status === "not_requested" && automatic && recording.status !== "failed") inProgress += 1;
    } else if (automatic && recording.status !== "failed") inProgress += 1;
  }
  return { status: ended === null ? "live" : transcribed > 0 ? "available" : inProgress > 0 ? "transcript_pending" : "no_transcript", inProgress };
}

/* -------------------------------------------------------------------------- */
/* dev CLI                                                                     */
/* -------------------------------------------------------------------------- */

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (/** @type {string} */ name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : (args[index + 1] ?? null);
  };
  const jobId = flag("--job");
  const episodeId = flag("--episode");
  const item = jobId !== null ? { kind: /** @type {const} */ ("job"), id: jobId } : episodeId !== null ? { kind: /** @type {const} */ ("episode"), id: episodeId } : null;
  if (item === null) {
    console.error("usage: node scripts/transcription-dispatcher/evidence.mjs --job <uuid> | --episode <uuid>");
    process.exitCode = 64;
  } else {
    const { world, notes } = await buildWorld(item);
    const evidence = world.evidence[item.id];
    if (evidence === undefined) throw new EvidenceError(`the built world has no evidence for ${item.id}`);
    /** @type {Record<string, number>} */
    const counts = {};
    for (const o of evidence.observations) counts[`${o.fact}@${o.source}`] = (counts[`${o.fact}@${o.source}`] ?? 0) + 1;
    console.log(JSON.stringify({ declaration: world.declarations[0], asof_ms: world.asof_ms, observations: counts, watermarks: evidence.watermarks }, null, 1));
    for (const note of notes) console.log(`note: ${note}`);
  }
}
