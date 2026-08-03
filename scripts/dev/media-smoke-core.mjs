import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

export const PHASES = Object.freeze({
  manifest: "manifest",
  browser: "browser",
  primaryJoin: "primary_join",
  guestJoin: "guest_join",
  media: "media",
  stats: "stats",
  stopCamera: "stop_camera",
  observability: "observability",
  cleanup: "cleanup",
});

export const UNSUPPORTED_ASSERTIONS = Object.freeze({
  inviteCapability: "invite_capability",
  joinUI: "join_ui",
  mediaTracker: "media_tracker",
  rtcStatsTracker: "rtc_stats_tracker",
  stopParticipantCameraUI: "stop_participant_camera_ui",
  observabilityProofEndpoint: "observability_proof_endpoint",
});

const DIRECTIONS = ["inbound", "outbound"];
const MEDIA_KINDS = ["audio", "video"];
const DEFAULT_JOIN_TIMEOUT_MS = 30_000;
const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;
const DEFAULT_STATS_WINDOW_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|capabilit(?:y|ies)|cookie|credential|invite|jwt|password|secret|sdp|candidate|token|raw|frame|audio_payload|video_payload|media_payload)/i;
const SECRET_VALUE = /(?:bearer\s+|(?:chalk|cf|sfu)[_-]?(?:sk|secret|token)[._-]?)[^\s,;]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class MediaProofError extends Error {
  constructor(code, message, { phase, details } = {}) {
    super(message);
    this.name = "MediaProofError";
    this.code = code;
    this.phase = phase;
    this.details = details;
  }
}

export class UnsupportedAssertionError extends MediaProofError {
  constructor(assertion, details) {
    super("unsupported_assertion", `Unsupported assertion: ${assertion}`, { details });
    this.name = "UnsupportedAssertionError";
    this.assertion = assertion;
  }
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "")?.trim();
}

function runtimeStatus(manifest) {
  return firstString(manifest.status, manifest.state, manifest.status?.state, manifest.runtime?.status, manifest.current?.status);
}

function localURL(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new MediaProofError("manifest_invalid_url", `${name} must be an absolute HTTP URL`);
  }
  if (!/^https?:$/.test(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new MediaProofError("manifest_non_local_url", `${name} must point to localhost`);
  }
  parsed.hash = "";
  return parsed;
}

function safeFilePart(value) {
  return (
    String(value)
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 80) || "runtime"
  );
}

export function normalizeReadyRuntimeManifest(manifest, options = {}) {
  if (!isRecord(manifest)) throw new MediaProofError("manifest_invalid", "Runtime manifest must be a JSON object");
  const status = runtimeStatus(manifest);
  if (status !== "ready") throw new MediaProofError("manifest_not_ready", `Runtime manifest is ${status || "missing status"}; expected ready`, { details: { status } });

  const runtimeID = firstString(manifest.runtimeId, manifest.runtime_id, typeof manifest.runtime === "string" ? manifest.runtime : undefined, manifest.runtime?.id, manifest.id);
  if (!runtimeID) throw new MediaProofError("manifest_missing_runtime_id", "Runtime manifest is missing runtime id");

  const webValue = firstString(options.webURL, options.webUrl, manifest.webURL, manifest.webUrl, manifest.web_url, manifest.web?.url, manifest.web?.baseURL, manifest.web?.baseUrl, manifest.urls?.web);
  if (!webValue) throw new MediaProofError("manifest_missing_web_url", "Runtime manifest is missing web URL");
  const webURL = localURL(webValue, "web URL");
  const webJoinPath = firstString(options.webJoinPath, options.web_join_path, manifest.webJoinPath, manifest.web_join_path);
  if (!webJoinPath || !webJoinPath.startsWith("/")) throw new MediaProofError("manifest_missing_web_join_path", "Runtime manifest is missing a web join path");

  const proofValue = firstString(
    options.proofEndpoint,
    options.observabilityProofURL,
    options.observabilityProofUrl,
    manifest.observabilityProofURL,
    manifest.observabilityProofUrl,
    manifest.proofEndpoint,
    manifest.proofURL,
    manifest.observability?.proofEndpoint,
    manifest.observability?.proofURL,
    manifest.observability?.proofUrl,
    manifest.observability?.proof,
    manifest.observability?.endpoint,
    manifest.proof?.endpoint,
    manifest.proof?.url,
  );
  if (!proofValue && typeof options.observabilityProof !== "function") throw new MediaProofError("manifest_missing_observability_proof", "Runtime manifest is missing observability proof endpoint");
  const observabilityProofURL = proofValue ? localURL(proofValue, "observability proof URL") : undefined;

  const privateDirectory = firstString(options.privateDirectory, manifest.privateDirectory, manifest.private_dir, manifest.runtimeDirectory, manifest.runtime_directory);
  const proofPath = firstString(options.proofPath, manifest.proofPath, manifest.proof?.path, manifest.observability?.proofPath, manifest.observability?.proof?.path) ?? (privateDirectory ? join(privateDirectory, "proof", `media-smoke-${safeFilePart(runtimeID)}.json`) : undefined);
  return Object.freeze({
    runtimeID,
    status,
    webURL: webURL.toString(),
    webOrigin: webURL.origin,
    webJoinPath,
    observabilityProofURL: observabilityProofURL?.toString(),
    observabilityContract: options.observabilityContract ?? manifest.observability?.contract ?? manifest.proof?.contract,
    proofPath,
    manifestPath: options.manifestPath,
    participantNames: {
      primary: firstString(options.primaryName, options.hostName, manifest.smoke?.primaryName, manifest.smoke?.hostName, manifest.smoke?.host_name) ?? "Chalk smoke primary",
      guest: firstString(options.guestName, manifest.smoke?.guestName, manifest.smoke?.guest_name) ?? "Chalk smoke guest",
    },
    joinTimeoutMs: positiveInteger(options.joinTimeoutMs ?? manifest.smoke?.joinTimeoutMs, DEFAULT_JOIN_TIMEOUT_MS),
    mediaTimeoutMs: positiveInteger(options.mediaTimeoutMs ?? manifest.smoke?.mediaTimeoutMs, DEFAULT_MEDIA_TIMEOUT_MS),
    statsWindowMs: Math.max(DEFAULT_STATS_WINDOW_MS, positiveInteger(options.statsWindowMs ?? manifest.smoke?.statsWindowMs, DEFAULT_STATS_WINDOW_MS)),
    pollIntervalMs: positiveInteger(options.pollIntervalMs ?? manifest.smoke?.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
  });
}

export async function readReadyRuntimeManifest(input, options = {}) {
  const manifestPath = typeof input === "string" ? input : firstString(options.manifestPath, process.env.CHALK_DEV_RUNTIME_MANIFEST);
  const manifest = manifestPath ? JSON.parse(await (options.readFile ?? readFile)(manifestPath, "utf8")) : input;
  return normalizeReadyRuntimeManifest(manifest, { ...options, manifestPath });
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function emptyRtcStats() {
  return Object.fromEntries(DIRECTIONS.map((direction) => [direction, Object.fromEntries(MEDIA_KINDS.map((kind) => [kind, { bytes: 0, packets: 0, streams: 0 }]))]));
}

export function aggregateRtcStats(stats) {
  const summary = emptyRtcStats();
  const values = stats && typeof stats.values === "function" ? stats.values() : (stats ?? []);
  for (const candidate of values) {
    if (!isRecord(candidate)) continue;
    const direction = candidate.type === "inbound-rtp" ? "inbound" : candidate.type === "outbound-rtp" ? "outbound" : undefined;
    const kind = candidate.kind ?? candidate.mediaType;
    if (!direction || !MEDIA_KINDS.includes(kind)) continue;
    const bucket = summary[direction][kind];
    const bytesField = direction === "inbound" ? "bytesReceived" : "bytesSent";
    const packetsField = direction === "inbound" ? "packetsReceived" : "packetsSent";
    bucket.bytes += finiteNonNegative(candidate[bytesField]);
    bucket.packets += finiteNonNegative(candidate[packetsField]);
    bucket.streams += 1;
  }
  return summary;
}

export const summarizeRtcStatsByKind = aggregateRtcStats;

export function deltaRtcStats(before, after) {
  return Object.fromEntries(
    DIRECTIONS.map((direction) => [
      direction,
      Object.fromEntries(MEDIA_KINDS.map((kind) => [kind, { bytes: after?.[direction]?.[kind]?.bytes - before?.[direction]?.[kind]?.bytes, packets: after?.[direction]?.[kind]?.packets - before?.[direction]?.[kind]?.packets, streams: after?.[direction]?.[kind]?.streams }])),
    ]),
  );
}

export function assertPositiveRtcDeltas(deltas) {
  for (const direction of DIRECTIONS) {
    for (const kind of MEDIA_KINDS) {
      const value = deltas?.[direction]?.[kind];
      if (!value || !(value.bytes > 0) || !(value.packets > 0)) throw new MediaProofError("rtc_stats_not_increasing", `${direction} ${kind} RTP counters did not increase`, { details: { direction, kind, delta: value } });
    }
  }
  return true;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function redactString(value) {
  const redacted = value.replace(SECRET_VALUE, "[redacted]");
  return redacted.replace(/((?:https?:\/\/|\/)[^\s?#]+)([?#][^\s]*)/g, (_match, path, queryOrFragment) => `${path}${redactURLValues(queryOrFragment)}`);
}

function redactURLValues(queryOrFragment) {
  return queryOrFragment.replace(/([?#&])([^#?&=\s]+)(?:=([^#?&\s]*))?/g, "$1$2=[redacted]");
}

export function redactProof(value, key = "", seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const result = Array.isArray(value) ? value.map((item) => redactProof(item, key, seen)) : Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactProof(entryValue, entryKey, seen)]));
  seen.delete(value);
  return result;
}

export function preserveFirstFailure(current, next) {
  return current ?? next;
}

export function createFailureRecorder() {
  let first;
  return {
    record(value) {
      first = preserveFirstFailure(first, value);
      return first;
    },
    get firstFailure() {
      return first;
    },
  };
}

export function failureFrom(error, phase) {
  const source = error instanceof Error ? error : new Error(String(error));
  return redactProof({ phase: error?.phase ?? phase, code: error?.code ?? "assertion_failed", assertion: error?.assertion, message: source.message, details: error?.details });
}

export async function runPhase(report, phase, action) {
  const record = { phase, status: "pending", startedAt: new Date().toISOString() };
  report.phases.push(record);
  try {
    const result = await action();
    record.status = "passed";
    record.finishedAt = new Date().toISOString();
    return result;
  } catch (error) {
    record.status = "failed";
    record.finishedAt = new Date().toISOString();
    record.failure = failureFrom(error, phase);
    report.failureRecorder.record(record.failure);
    throw error;
  }
}

export function unsupported(assertion, details) {
  throw new UnsupportedAssertionError(assertion, details);
}

export async function waitFor(description, predicate, { timeoutMs, intervalMs, sleep, now } = {}) {
  const wait = sleep ?? ((duration) => new Promise((resolvePromise) => setTimeout(resolvePromise, duration)));
  const clock = now ?? Date.now;
  const deadline = clock() + timeoutMs;
  while (clock() <= deadline) {
    if (await predicate()) return true;
    await wait(Math.min(intervalMs ?? DEFAULT_POLL_INTERVAL_MS, Math.max(1, deadline - clock())));
  }
  throw new MediaProofError("timeout", `${description} timed out`);
}
