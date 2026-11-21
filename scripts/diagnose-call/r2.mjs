// @ts-check
/**
 * The R2 adapter behind `check`'s ports: the checker's own GET of a diagnostic bundle, gunzip, JSON parse and identity
 * match. A HEAD is not a readback. Reads a host directory under CHALK_DIAGNOSE_R2_DIR, or the bucket named by
 * CHALK_R2_ENDPOINT, CHALK_R2_BUCKET, CHALK_R2_ACCESS_KEY_ID and CHALK_R2_SECRET_ACCESS_KEY with a SigV4 GET built from
 * node:crypto alone — no SDK dependency.
 *
 * Returns a `report.r2_upload` claim: ok | missing | read_failed | parse_failed | identity_mismatch. Object keys, signed
 * urls and bundle bodies never leave this file.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { gunzipSync } from "node:zlib";

/** @typedef {{ episode_id?: string, participant_id?: string, client_session_id?: string }} Identity */
/** @typedef {{ readback: "ok" | "missing" | "read_failed" | "parse_failed" | "identity_mismatch", at_ms: number, bytes?: number, parts: Record<string, string> }} Readback */

const sha256 = (/** @type {Buffer | string} */ data) => createHash("sha256").update(data).digest("hex");
const hmac = (/** @type {Buffer | string} */ key, /** @type {string} */ data) => createHmac("sha256", key).update(data).digest();
const PART_KEYS = ["state", "surface_tree", "flight_recorder"];

/** A part's printable status for the live view: observed(<bytes>) or unavailable(<reason>). */
const partStatus = (part) => {
  if (part === null || part === undefined) return "unavailable(not_built)";
  if (part.status === "observed") return `observed(${part.bytes ?? "?"})`;
  return `unavailable(${part.reason ?? "unknown"})`;
};

/** The bundle's identity in `state`: named fields only. @param {Record<string, any>} doc @returns {Identity} */
const identityOf = (doc) => {
  const state = doc?.state?.value ?? doc?.state ?? {};
  return {
    episode_id: typeof state.episode_id === "string" ? state.episode_id : undefined,
    participant_id: typeof state.participant_id === "string" ? state.participant_id : undefined,
    client_session_id: typeof state.client_session_id === "string" ? state.client_session_id : undefined,
  };
};

/** GET the object body: from the host dir, or the bucket over SigV4. `null` = absent. */
async function getObject(key, env) {
  const dir = env.CHALK_DIAGNOSE_R2_DIR;
  if (dir !== undefined && dir !== "") {
    const path = join(dir, key);
    return existsSync(path) ? readFileSync(path) : null;
  }
  const endpoint = env.CHALK_R2_ENDPOINT, bucket = env.CHALK_R2_BUCKET, id = env.CHALK_R2_ACCESS_KEY_ID, secret = env.CHALK_R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !id || !secret) throw new Error("r2 not read: no CHALK_DIAGNOSE_R2_DIR and no CHALK_R2_* credentials");
  const host = new URL(endpoint).host;
  const path = `/${bucket}/${key}`;
  const now = new Date();
  const date = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "") + "Z";
  const day = date.slice(0, 8);
  const emptyHash = sha256("");
  const canonical = `GET\n${path}\n\nhost:${host}\nx-amz-content-sha256:${emptyHash}\nx-amz-date:${date}\n\nhost;x-amz-content-sha256;x-amz-date\n${emptyHash}`;
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonical)}`;
  const k = ["AWS4" + secret, day, "auto", "s3", "aws4_request"].reduce((acc, part) => hmac(acc, part), /** @type {Buffer | string} */ ("AWS4" + secret));
  const signature = createHmac("sha256", k).update(toSign).digest("hex");
  const answer = await fetch(`${endpoint}${path}`, { headers: { "x-amz-date": date, "x-amz-content-sha256": emptyHash, Authorization: `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}` } });
  if (answer.status === 404) return null;
  if (!answer.ok) throw new Error(`r2 read failed: HTTP ${answer.status}`);
  return Buffer.from(await answer.arrayBuffer());
}

/**
 * One readback of a diagnostic bundle: GET, gunzip, JSON.parse and the identity match.
 * @param {{ key: string, expect: Identity, env?: NodeJS.ProcessEnv }} input
 * @returns {Promise<Readback>}
 */
export async function r2Readback({ key, expect, env = process.env }) {
  const at = Date.now();
  /** @type {Buffer | null} */
  let body;
  try {
    body = await getObject(key, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/404|NoSuchKey|not read/.test(message)) return { readback: message.includes("not read") ? "read_failed" : "missing", at_ms: at, parts: {} };
    return { readback: "read_failed", at_ms: at, parts: {} };
  }
  if (body === null) return { readback: "missing", at_ms: at, parts: {} };
  /** @type {Record<string, any>} */
  let doc;
  try {
    doc = JSON.parse(gunzipSync(body).toString("utf8"));
  } catch {
    return { readback: "parse_failed", at_ms: at, bytes: body.length, parts: {} };
  }
  if (doc?.diagnostic_bundle !== 1 && doc?.version !== 1 && doc?.diagnostic_bundle !== "1") {
    return { readback: "parse_failed", at_ms: at, bytes: body.length, parts: {} };
  }
  const parts = {};
  for (const name of PART_KEYS) parts[`${name === "flight_recorder" ? "flight_recorder_part" : name === "surface_tree" ? "surface_tree_part" : "state_part"}`] = partStatus(doc.parts?.[name] ?? doc[name]);
  const identity = identityOf(doc);
  for (const [field, want] of Object.entries(expect)) {
    if (want !== undefined && identity[field] !== undefined && identity[field] !== want) {
      return { readback: "identity_mismatch", at_ms: at, bytes: body.length, parts };
    }
    if (want !== undefined && identity[field] === undefined) {
      return { readback: "identity_mismatch", at_ms: at, bytes: body.length, parts };
    }
  }
  return { readback: "ok", at_ms: at, bytes: body.length, parts };
}
