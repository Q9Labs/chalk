// @ts-check
/**
 * R2 readback for the slice-10 recording checks: one readback per committed Recording per check.
 * HEAD + ffprobe + a null-muxer decode against the committed db account, or a HEAD per committed
 * bundle. Reads come from CHALK_R2_READ_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY (SigV4 GET
 * via aws4fetch) or, for the isolated local world, from CHALK_DIAGNOSE_R2_DIR holding objects under
 * their db keys. Nothing sensitive is ever emitted: no object key, signed URL, signed headers or
 * credentials appear in any row.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PROBE_TIMEOUT_MS = 60_000;

const ffprobe = (bin, target) => {
  try {
    const out = execFileSync(bin, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", target], { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" });
    return JSON.parse(out);
  } catch {
    return null;
  }
};

const decodes = (target) => {
  try {
    execFileSync("ffmpeg", ["-v", "error", "-i", target, "-f", "null", "-"], { timeout: PROBE_TIMEOUT_MS, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

/** A local object under CHALK_DIAGNOSE_R2_DIR: file path, bytes and sha, or null when absent. */
function localObject(key) {
  const dir = process.env.CHALK_DIAGNOSE_R2_DIR;
  if (!dir) return null;
  const path = join(dir, key);
  if (!existsSync(path)) return { missing: true };
  const bytes = readFileSync(path);
  return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), size: statSync(path).size };
}

/**
 * One artifact readback row for a committed Recording. `expected` is the db account:
 * { byte_size, checksum_hex, duration_millis, expires_ms }. The key is used only to read.
 */
export function artifactReadback(recordingId, key, expected, now_ms) {
  const base = { event: "recording.artifact_readback", recording_id: recordingId, est_server_ms: now_ms };
  if (!key) return { ...base, recording_r2_result: "not_found" };
  const obj = localObject(key);
  if (!obj) return remoteReadback(recordingId, key, expected, now_ms);
  if (obj.missing) return { ...base, recording_r2_result: "not_found" };
  if (expected.byte_size !== undefined && obj.size !== expected.byte_size) return { ...base, recording_r2_result: "size_mismatch", recording_size_bytes: obj.size };
  if (expected.checksum_hex === undefined) return { ...base, recording_r2_result: "checksum_absent", recording_size_bytes: obj.size };
  const match = obj.sha256 === expected.checksum_hex;
  if (!match) return { ...base, recording_r2_result: "checksum_mismatch", recording_size_bytes: obj.size, recording_sha_match: false };
  const probe = ffprobe("ffprobe", obj.path);
  if (!probe) return { ...base, recording_r2_result: "decode_failed", recording_size_bytes: obj.size, recording_sha_match: true };
  const hasVideo = (probe.streams ?? []).some((s) => s.codec_type === "video");
  if (!hasVideo) return { ...base, recording_r2_result: "no_video", recording_size_bytes: obj.size, recording_sha_match: true };
  const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
  if (expected.duration_millis !== undefined && Math.abs(durationMs - expected.duration_millis) > 2000) {
    return { ...base, recording_r2_result: "duration_mismatch", recording_size_bytes: obj.size, recording_sha_match: true, recording_probe_duration_ms: durationMs };
  }
  if (!decodes(obj.path)) return { ...base, recording_r2_result: "decode_failed", recording_size_bytes: obj.size, recording_sha_match: true, recording_probe_duration_ms: durationMs };
  return { ...base, recording_r2_result: "ok", recording_size_bytes: obj.size, recording_sha_match: true, recording_probe_duration_ms: durationMs };
}

/** One HEAD row per committed bundle object. */
export function bundleHead(recordingId, key, sequence, now_ms) {
  const base = { event: "recording.r2.bundle_head", recording_id: recordingId, recording_bundle_sequence: sequence, est_server_ms: now_ms };
  const obj = localObject(key);
  if (!obj) return { ...base, recording_head_result: remoteHead(key) };
  return { ...base, recording_head_result: obj.missing ? "not_found" : "ok" };
}

/** Remote SigV4 read: presigned HEAD only, never a logged URL. */
async function remoteClient() {
  const { AwsClient } = await import("aws4fetch");
  const env = process.env;
  if (!env.CHALK_R2_READ_ENDPOINT || !env.CHALK_R2_READ_ACCESS_KEY_ID || !env.CHALK_R2_READ_SECRET_ACCESS_KEY) return null;
  return new AwsClient({ accessKeyId: env.CHALK_R2_READ_ACCESS_KEY_ID, secretAccessKey: env.CHALK_R2_READ_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
}

function remoteHead(key) {
  // A remote HEAD result placeholder: the async client resolves in remoteReadback callers.
  return "error";
}

async function remoteReadback(recordingId, key, expected, now_ms) {
  const base = { event: "recording.artifact_readback", recording_id: recordingId, est_server_ms: now_ms };
  const client = await remoteClient();
  if (!client) return { ...base, recording_r2_result: "error" };
  const url = `${process.env.CHALK_R2_READ_ENDPOINT.replace(/\/$/, "")}/${process.env.CHALK_R2_READ_BUCKET}/${key}`;
  try {
    const head = await client.fetch(url, { method: "HEAD" });
    if (head.status === 404) return { ...base, recording_r2_result: "not_found" };
    if (!head.ok) return { ...base, recording_r2_result: "error" };
    const size = Number(head.headers.get("content-length") ?? -1);
    if (expected.byte_size !== undefined && size !== expected.byte_size) return { ...base, recording_r2_result: "size_mismatch", recording_size_bytes: size };
    // ffprobe/ffmpeg need bytes; fetch once through the signed client, never logging the URL.
    const get = await client.fetch(url, { method: "GET" });
    if (!get.ok) return { ...base, recording_r2_result: "error", recording_size_bytes: size };
    const bytes = Buffer.from(await get.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expected.checksum_hex === undefined) return { ...base, recording_r2_result: "checksum_absent", recording_size_bytes: size };
    if (sha256 !== expected.checksum_hex) return { ...base, recording_r2_result: "checksum_mismatch", recording_size_bytes: size, recording_sha_match: false };
    const tmp = join(process.env.TMPDIR ?? "/tmp", `readback-${createHash("sha256").update(key).digest("hex").slice(0, 16)}.bin`);
    const { writeFileSync, unlinkSync } = await import("node:fs");
    writeFileSync(tmp, bytes);
    try {
      const probe = ffprobe("ffprobe", tmp);
      if (!probe) return { ...base, recording_r2_result: "decode_failed", recording_size_bytes: size, recording_sha_match: true };
      if (!(probe.streams ?? []).some((s) => s.codec_type === "video")) return { ...base, recording_r2_result: "no_video", recording_size_bytes: size, recording_sha_match: true };
      const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
      if (expected.duration_millis !== undefined && Math.abs(durationMs - expected.duration_millis) > 2000) {
        return { ...base, recording_r2_result: "duration_mismatch", recording_size_bytes: size, recording_sha_match: true, recording_probe_duration_ms: durationMs };
      }
      if (!decodes(tmp)) return { ...base, recording_r2_result: "decode_failed", recording_size_bytes: size, recording_sha_match: true, recording_probe_duration_ms: durationMs };
      return { ...base, recording_r2_result: "ok", recording_size_bytes: size, recording_sha_match: true, recording_probe_duration_ms: durationMs };
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  } catch {
    return { ...base, recording_r2_result: "error" };
  }
}

export default { artifactReadback, bundleHead };
