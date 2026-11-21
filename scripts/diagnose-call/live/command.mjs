// @ts-check
/**
 * `diagnose live <who>`: issues one live-introspection request and reports what it did — a request, not a check, so its
 * header carries no verdict fields. `<who>` is a seat (`pt_…` or a participants id); the seat's Tenant and Episode come
 * from Postgres, never from the command line.
 *
 * - POSTs `/operator/diagnostics/live-requests` with the bearer whose SHA-256 the API checks
 *   (`CHALK_OPERATOR_DIAGNOSE_TOKEN`, compared as a hash server-side).
 * - Waits for the row's `delivery`, then for `live` uploads, polling Postgres — Sync does not poll, so a `delivery`
 *   that stays null past `expires_at` is the listener hop itself.
 * - GETs each stored bundle from R2 (`r2.mjs`) and prints one `upload dg_x readback=…` line per bundle.
 *
 * Environment: CHALK_DATABASE_URL, CHALK_API_URL, CHALK_OPERATOR_DIAGNOSE_TOKEN, and the CHALK_DIAGNOSE_R2_* or
 * CHALK_R2_* read when a bundle stores. Descriptions, bundle bodies and tokens never print.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { r2Readback } from "../r2.mjs";

const run = promisify(execFile);
const PT = /^pt_[0-9a-z]+$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const WAIT_DELIVERY_MS = 70_000;
const WAIT_UPLOAD_MS = 130_000;
const POLL_MS = 2_000;

export class LiveError extends Error {}

const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

async function psql(url, sql) {
  const { stdout } = await run("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: process.env, maxBuffer: 16 << 20 }).catch((error) => {
    throw new LiveError(`psql failed: ${String(error.code ?? error.message)}`);
  });
  const text = stdout.trim();
  return text === "" ? null : JSON.parse(text);
}
const q = (/** @type {string} */ s) => `'${s.replaceAll("'", "''")}'`;

/** The seat's Tenant and Episode: a pt_ handle or participants uuid. */
async function seatOf(databaseUrl, who) {
  const where = PT.test(who) ? `p.id = ${q(who)}` : UUID.test(who) ? `p.id = ${q(who)}::uuid` : null;
  if (where === null) throw new LiveError(`diagnose live needs a pt_ seat id or a participants uuid, got ${JSON.stringify(who.slice(0, 40))}`);
  const row = await psql(databaseUrl, `select json_build_object('participant',p.id,'tenant',p.tenant_id,'episode',p.episode_id,'status',p.status,'left_at',p.left_at) from participants p where ${where} order by p.created_at desc limit 1`);
  if (row === null) throw new LiveError(`no seat ${who}`);
  return row;
}

async function requestRow(databaseUrl, id) {
  return psql(databaseUrl, `select json_build_object('id',l.id,'participant_id',l.participant_id,'requested_at',l.requested_at,'expires_at',l.expires_at,'participant_status',l.participant_status,'episode_status',l.episode_status,'delivery',l.delivery,'delivered_at',l.delivered_at,'sockets',l.sockets,'unavailable_reason',l.unavailable_reason) from live_introspection_requests l where l.id = ${q(id)}::uuid`);
}

async function uploadRows(databaseUrl, requestId) {
  return (await psql(databaseUrl, `select coalesce(json_agg(json_build_object('id',u.id,'state',u.state,'object_key',u.object_key,'participant_id',l.participant_id,'bytes',u.bytes)), '[]'::json) from diagnostic_uploads u left join live_introspection_requests l on l.id = u.live_request_id where u.live_request_id = ${q(requestId)}::uuid`)) ?? [];
}

/** Format the `live` view: one request line, one ack/delivery line, one upload line per bundle. */
export function liveView({ seat, request, acks, uploads }) {
  const lines = [
    `live ${seat.participant} request ${request.id}`,
    `  seat: status=${request.participant_status ?? "?"} episode_status=${request.episode_status ?? "?"}`,
    `  delivery: ${request.delivery ?? `pending (expires ${request.expires_at})`}${request.delivered_at ? ` at ${request.delivered_at}` : ""}${request.unavailable_reason ? ` (${request.unavailable_reason})` : ""}`,
    `  ack: ${acks > 0 ? `${acks} socket(s)` : "none"}`,
    ...uploads.map((u) => `  upload ${u.id} readback=${u.readback ?? `${u.state} (not read)`}${u.state !== "stored" ? ` state=${u.state}` : ""}`),
  ];
  if (uploads.length === 0) lines.push("  upload: none");
  return lines.join("\n") + "\n";
}

/**
 * Runs `diagnose live <who>`.
 * @param {string} who
 * @param {NodeJS.ProcessEnv} env
 * @param {{ now?: number }} [options]
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
export async function liveCommand(who, env, { now = Date.now() } = {}) {
  const databaseUrl = env.CHALK_DATABASE_URL;
  const apiUrl = env.CHALK_API_URL;
  const token = env.CHALK_OPERATOR_DIAGNOSE_TOKEN;
  if (!databaseUrl) throw new LiveError("diagnose live needs CHALK_DATABASE_URL");
  if (!apiUrl || !token) throw new LiveError("diagnose live needs CHALK_API_URL and CHALK_OPERATOR_DIAGNOSE_TOKEN");
  const seat = await seatOf(databaseUrl, who);
  const answer = await fetch(`${apiUrl.replace(/\/$/, "")}/operator/diagnostics/live-requests`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ tenant_id: seat.tenant, episode_id: seat.episode, participant_id: seat.participant }),
  }).catch(() => {
    throw new LiveError("the live request POST failed");
  });
  if (!answer.ok) throw new LiveError(`the API refused the live request (HTTP ${answer.status})`);
  const { request_id } = /** @type {{ request_id: string }} */ (await answer.json());

  // Poll for delivery until the row's expiry, then for uploads past it. Sync writes delivery itself; a null past
  // expires_at means the notification listener never delivered.
  let request = await requestRow(databaseUrl, request_id);
  const deadline = Date.parse(request.expires_at) + WAIT_DELIVERY_MS;
  while (request.delivery === null && Date.now() < deadline) {
    await sleep(POLL_MS);
    request = await requestRow(databaseUrl, request_id);
  }
  const delivered = typeof request.delivery === "string" && request.delivery.startsWith("delivered");
  // Uploads: poll until one stores, a failed/issued row settles, or the upload window closes.
  const uploadDeadline = Date.now() + WAIT_UPLOAD_MS;
  let uploads = await uploadRows(databaseUrl, request_id);
  while (delivered && !uploads.some((u) => u.state === "stored" || u.state === "failed") && Date.now() < uploadDeadline) {
    await sleep(POLL_MS);
    uploads = await uploadRows(databaseUrl, request_id);
  }
  // One readback per stored bundle.
  const withReads = [];
  const r2 = env.CHALK_DIAGNOSE_R2_DIR || (env.CHALK_R2_ENDPOINT && env.CHALK_R2_BUCKET && env.CHALK_R2_ACCESS_KEY_ID && env.CHALK_R2_SECRET_ACCESS_KEY);
  for (const u of uploads) {
    let readback;
    if (u.state === "stored" && r2 && typeof u.object_key === "string") {
      const back = await r2Readback({ key: u.object_key, expect: { episode_id: seat.episode, participant_id: u.participant_id, client_session_id: u.client_session_id }, env });
      readback = back.readback;
    }
    withReads.push({ ...u, readback });
  }
  return { code: 0, out: liveView({ seat, request, acks: delivered ? Number(request.sockets ?? 1) : 0, uploads: withReads }), err: "" };
}
