// @ts-check
/**
 * The tenant-day webhook and integration reader: one tenant's day of webhook lifecycle transitions, events, endpoints,
 * deliveries, attempts, retries, resources and API-key state out of Postgres, plus the API log lines that carry the request
 * journal, the access-grant rejections, the dispatcher's completion failures and the boot markers. Every event name here is a
 * registry event under areas/webhooks.json; the rows it prints are the same kernel-row shape the Axiom reader returns, so the
 * fixtures and the live path read them through the one row mapping in proof/rows.mjs.
 *
 * Usage:
 *   node scripts/diagnose-call/live/webhooks.mjs --tenant <uuid> --from <ms> --to <ms> [--api-log <path>]
 * Environment: CHALK_DATABASE_URL (read-only). Values never go on a command line: psql reads PG* variables.
 * With no --api-log, only the db rows are read; the log facts read as unknown to the checks, never absent.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { connectionEnv } from "../database.mjs";

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MS = "(extract(epoch from %s) * 1000)::bigint";

/** @param {string} iso */
const ms = (iso) => Date.parse(iso);
/** @param {number} at */
const iso = (at) => new Date(at).toISOString();

let seq = 0;
/**
 * One kernel-shaped row for a db or log event.
 * @param {string} name @param {number} at @param {Record<string, unknown>} fields
 */
const row = (name, at, fields) => ({ kind: "fact", name, module: "api", source: name.startsWith("integration.log") || name.startsWith("webhook.log") ? "api" : "db", event_id: randomUUID(), seq: ++seq, source_id: "00000000-0000-4000-8000-00000000000a", env: "test", clock_state: "server", est_server_ms: at, tenant_id: TENANT, ...fields });
// event names used (registry emit-site literals):
// webhook.db.lifecycle webhook.db.event webhook.db.endpoint webhook.db.delivery webhook.db.attempt webhook.db.retry
// webhook.db.episode webhook.db.space webhook.db.participant integration.db.api_key integration.db.key_mutation
// webhook.log.api_start webhook.log.complete_failed integration.log.http_request integration.log.grant_rejected

let TENANT = "";

/** @param {Record<string, any>} r @param {string} key @returns {number | undefined} */
const ts = (r, key) => (r[key] === null || r[key] === undefined ? undefined : Number(r[key]));

/**
 * @param {string} sql
 * @returns {Promise<Record<string, any>[]>}
 */
async function query(sql) {
  const { stdout } = await run("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: connectionEnv(process.env.CHALK_DATABASE_URL ?? ""), maxBuffer: 32 << 20 });
  return stdout.trim() === "" ? [] : stdout.trim().split("\n").map((line) => JSON.parse(line));
}

/**
 * Postgres rows for one tenant-day.
 * @param {number} fromMs @param {number} toMs
 */
async function dbRows(fromMs, toMs) {
  const from = iso(fromMs);
  const to = iso(toMs);
  const rows = [];
  const episodes = await query(`select jsonb_build_object('id', e.id, 'tenant_id', e.tenant_id, 'space_id', e.space_id, 'created_at', e.created_at, 'started_at', e.started_at, 'ended_at', e.ended_at, 'deadline_at', e.deadline_at) from episodes e where e.tenant_id = '${TENANT}'::uuid and e.created_at < '${to}'::timestamptz and coalesce(e.ended_at, e.created_at) >= '${from}'::timestamptz order by e.created_at, e.id`);
  for (const ep of episodes) {
    rows.push(row("webhook.db.episode", ms(ep.created_at), { episode_id: ep.id, space_id: ep.space_id, created_at_ms: ms(ep.created_at), started_at_ms: ts(ep, "started_at") !== undefined ? ms(ep.started_at) : undefined, ended_at_ms: ep.ended_at ? ms(ep.ended_at) : undefined, deadline_at_ms: ep.deadline_at ? ms(ep.deadline_at) : undefined }));
    if (ep.started_at && ms(ep.started_at) >= fromMs && ms(ep.started_at) <= toMs) rows.push(row("webhook.db.lifecycle", ms(ep.started_at), { event_name: "episode.started", resource_id: ep.id, episode_id: ep.id, space_id: ep.space_id, occurred_at_ms: ms(ep.started_at) }));
    if (ep.ended_at && ms(ep.ended_at) >= fromMs && ms(ep.ended_at) <= toMs) rows.push(row("webhook.db.lifecycle", ms(ep.ended_at), { event_name: "episode.ended", resource_id: ep.id, episode_id: ep.id, space_id: ep.space_id, occurred_at_ms: ms(ep.ended_at) }));
  }
  const participants = await query(`select jsonb_build_object('id', p.id, 'tenant_id', p.tenant_id, 'episode_id', p.episode_id, 'generation', p.generation, 'created_at', p.created_at, 'joined_at', p.joined_at, 'left_at', p.left_at) from participants p where p.tenant_id = '${TENANT}'::uuid and p.created_at < '${to}'::timestamptz and coalesce(p.left_at, p.created_at) >= '${from}'::timestamptz order by p.created_at, p.id`);
  for (const pt of participants) {
    rows.push(row("webhook.db.participant", ms(pt.created_at), { participant_id: pt.id, episode_id: pt.episode_id, created_at_ms: ms(pt.created_at), joined_at_ms: pt.joined_at ? ms(pt.joined_at) : undefined, left_at_ms: pt.left_at ? ms(pt.left_at) : undefined }));
    if (pt.joined_at && ms(pt.joined_at) >= fromMs && ms(pt.joined_at) <= toMs) rows.push(row("webhook.db.lifecycle", ms(pt.joined_at), { event_name: "participant.joined", resource_id: pt.id, participant_id: pt.id, episode_id: pt.episode_id, generation: pt.generation, occurred_at_ms: ms(pt.joined_at) }));
    if (pt.left_at && ms(pt.left_at) >= fromMs && ms(pt.left_at) <= toMs) rows.push(row("webhook.db.lifecycle", ms(pt.left_at), { event_name: "participant.left", resource_id: pt.id, participant_id: pt.id, episode_id: pt.episode_id, generation: pt.generation, occurred_at_ms: ms(pt.left_at) }));
  }
  const spaces = await query(`select jsonb_build_object('id', s.id, 'created_at', s.created_at) from spaces s where s.tenant_id = '${TENANT}'::uuid and s.created_at < '${to}'::timestamptz order by s.id`);
  for (const sp of spaces) rows.push(row("webhook.db.space", ms(sp.created_at), { space_id: sp.id, created_at_ms: ms(sp.created_at) }));
  const events = await query(`select jsonb_build_object('id', w.id, 'event_name', w.event_name, 'resource_id', w.resource_id, 'occurred_at', w.occurred_at, 'journey_id', w.journey_id, 'semantic_transition_key', w.semantic_transition_key, 'api_version', w.api_version) from webhook_events w where w.tenant_id = '${TENANT}'::uuid and w.occurred_at >= '${from}'::timestamptz and w.occurred_at <= '${to}'::timestamptz order by w.occurred_at, w.id`);
  for (const ev of events) rows.push(row("webhook.db.event", ms(ev.occurred_at), { webhook_event_id: ev.id, event_name: ev.event_name, resource_id: ev.resource_id, occurred_at_ms: ms(ev.occurred_at), journey_id: ev.journey_id, semantic_transition_key: ev.semantic_transition_key, api_version: ev.api_version }));
  const revisions = await query(`select jsonb_build_object('endpoint_id', r.endpoint_id, 'revision', r.revision, 'api_version', r.api_version, 'event_types', r.event_types, 'created_at', r.created_at, 'enabled', e.enabled, 'current', (e.revision = r.revision), 'endpoint_created_at', e.created_at, 'endpoint_updated_at', e.updated_at, 'deleted_at', e.deleted_at) from webhook_endpoint_revisions r join webhook_endpoints e on e.tenant_id = r.tenant_id and e.id = r.endpoint_id where r.tenant_id = '${TENANT}'::uuid and r.created_at <= '${to}'::timestamptz order by r.endpoint_id, r.revision`);
  for (const rev of revisions) {
    rows.push(row("webhook.db.endpoint", ms(rev.created_at), { webhook_endpoint_id: rev.endpoint_id, enabled: rev.enabled, current: rev.current, api_version: rev.api_version, subscribed: (rev.event_types ?? []).join(","), occurred_at_ms: ms(rev.created_at), created_at_ms: ms(rev.endpoint_created_at), updated_at_ms: ms(rev.endpoint_updated_at), deleted_at_ms: rev.deleted_at ? ms(rev.deleted_at) : undefined }));
  }
  const deliveries = await query(`select jsonb_build_object('id', d.id, 'state', d.state, 'endpoint_id', d.endpoint_id, 'event_id', d.event_id, 'next_attempt_at', d.next_attempt_at, 'attempt_count', d.attempt_count, 'lease_expires_at', d.lease_expires_at, 'terminal_at', d.terminal_at, 'parent_delivery_id', d.parent_delivery_id, 'created_at', d.created_at, 'event_name', w.event_name, 'resource_id', w.resource_id, 'occurred_at', w.occurred_at) from webhook_deliveries d join webhook_events w on w.tenant_id = d.tenant_id and w.id = d.event_id where d.tenant_id = '${TENANT}'::uuid and d.created_at <= '${to}'::timestamptz order by d.created_at, d.id`);
  for (const d of deliveries) {
    rows.push(row("webhook.db.delivery", ts(d, "terminal_at") !== undefined ? ms(d.terminal_at) : ms(d.created_at), { webhook_delivery_id: d.id, delivery_state: d.state, webhook_endpoint_id: d.endpoint_id, webhook_event_id: d.event_id, event_name: d.event_name, resource_id: d.resource_id, occurred_at_ms: ms(d.occurred_at), next_attempt_at_ms: d.next_attempt_at ? ms(d.next_attempt_at) : undefined, attempt_count: d.attempt_count, lease_expires_at_ms: d.lease_expires_at ? ms(d.lease_expires_at) : undefined, terminal_at_ms: d.terminal_at ? ms(d.terminal_at) : undefined, parent_delivery_id: d.parent_delivery_id ?? undefined, created_at_ms: ms(d.created_at) }));
  }
  const attempts = await query(`select jsonb_build_object('id', a.id, 'delivery_id', a.delivery_id, 'attempt_number', a.attempt_number, 'outcome', a.outcome, 'http_status', a.http_status, 'error_code', a.error_code, 'started_at', a.started_at, 'finished_at', a.finished_at, 'latency_milliseconds', a.latency_milliseconds) from webhook_delivery_attempts a where a.tenant_id = '${TENANT}'::uuid and a.started_at <= '${to}'::timestamptz order by a.delivery_id, a.attempt_number`);
  for (const a of attempts) {
    const outcome = { succeeded: "succeeded", retryable_failure: "failed", terminal_failure: "failed", lease_expired: "lease_expired" }[a.outcome];
    if (outcome === undefined) continue;
    const statusClass = typeof a.http_status === "number" && a.http_status >= 200 && a.http_status < 600 ? `${Math.floor(a.http_status / 100)}xx` : "none";
    rows.push(row("webhook.db.attempt", a.finished_at ? ms(a.finished_at) : ms(a.started_at), { attempt_id: a.id, webhook_delivery_id: a.delivery_id, attempt_number: a.attempt_number, attempt_outcome: outcome, http_status: a.http_status ?? undefined, http_status_class: statusClass, error_code: a.error_code ?? undefined, started_at_ms: ms(a.started_at), finished_at_ms: a.finished_at ? ms(a.finished_at) : undefined, latency_milliseconds: a.latency_milliseconds ?? undefined }));
  }
  const retries = await query(`select jsonb_build_object('delivery_id', j.attributes->>'delivery_id', 'next_attempt_at', j.attributes->>'next_attempt_at', 'occurred_at', j.occurred_at, 'event_id', j.event_id) from observability_journey_events j join webhook_deliveries d on d.tenant_id = '${TENANT}'::uuid and d.id::text = j.attributes->>'delivery_id' where j.name = 'webhook.delivery.retry_scheduled' and j.occurred_at <= '${to}'::timestamptz order by j.occurred_at, j.event_id`);
  for (const r of retries) {
    rows.push(row("webhook.db.retry", ms(r.occurred_at), { webhook_delivery_id: r.delivery_id, next_attempt_at_ms: r.next_attempt_at ? Date.parse(r.next_attempt_at) : undefined, occurred_at_ms: ms(r.occurred_at) }));
  }
  const keys = await query(`select jsonb_build_object('id', k.id, 'key_prefix', k.key_prefix, 'scopes', k.scopes, 'created_at', k.created_at, 'revoked_at', k.revoked_at, 'expires_at', k.expires_at, 'last_used_at', k.last_used_at) from api_keys k where k.tenant_id = '${TENANT}'::uuid and k.created_at <= '${to}'::timestamptz order by k.created_at, k.id`);
  for (const k of keys) {
    rows.push(row("integration.db.api_key", ms(k.created_at), { api_key_id: k.id, key_prefix: k.key_prefix, scopes: (k.scopes ?? []).join(","), key_created_ms: ms(k.created_at), revoked_at_ms: k.revoked_at ? ms(k.revoked_at) : undefined, key_expires_at_ms: k.expires_at ? ms(k.expires_at) : undefined, last_used_at_ms: k.last_used_at ? ms(k.last_used_at) : undefined }));
  }
  const mutations = await query(`select jsonb_build_object('operation', m.operation, 'api_key_id', m.api_key_id, 'created_at', m.created_at) from api_key_mutation_requests m where m.tenant_id = '${TENANT}'::uuid and m.created_at <= '${to}'::timestamptz order by m.created_at, m.api_key_id`);
  for (const m of mutations) {
    rows.push(row("integration.db.key_mutation", ms(m.created_at), { mutation_kind: m.operation, api_key_id: m.api_key_id ?? undefined, mutation_created_ms: ms(m.created_at) }));
  }
  return rows;
}

/**
 * The API log lines that carry slice-12 evidence: kernel rows (kind+name), plus the legacy `event=` lines for boot, request,
 * grant and completion evidence.
 * @param {string} path
 */
function logRows(path) {
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    /** @type {Record<string, any>} */
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const at = parsed.est_server_ms ?? (parsed.time ? Date.parse(parsed.time) : undefined);
    if (typeof at !== "number") continue;
    if (parsed.name && parsed.kind) {
      rows.push({ source_id: parsed.source_id ?? "00000000-0000-4000-8000-00000000000a", source: "api", tenant_id: TENANT, ...parsed, seq: ++seq });
      continue;
    }
    if (parsed.event === "api.starting") {
      rows.push(row("webhook.log.api_start", at, { api_start: true, request_logs: parsed.request_logs, previous_boot_end_ms: parsed.previous_boot_end ? Date.parse(parsed.previous_boot_end) : undefined, host_boot_id: parsed.host_boot_id ?? undefined }));
    } else if (parsed.event === "http.request") {
      const segments = typeof parsed.path === "string" ? parsed.path.split("/") : [];
      const segment = (name) => {
        const at2 = segments.indexOf(name);
        return at2 !== -1 && UUID.test(segments[at2 + 1] ?? "") ? segments[at2 + 1] : undefined;
      };
      rows.push(row("integration.log.http_request", at, { method: parsed.method, path: parsed.path ?? parsed.route, route: parsed.route, status: parsed.status, error_code: parsed.code ?? parsed.error_code ?? undefined, outcome: parsed.outcome ?? (typeof parsed.status === "number" && parsed.status < 400 ? "ok" : "error"), api_key_id: parsed.api_key_id ?? undefined, auth_scheme: parsed.auth_scheme ?? undefined, space_id: segment("spaces"), episode_id: segment("episodes"), participant_id: segment("participants") }));
    } else if (parsed.event === "access_grant.rejected") {
      rows.push(row("integration.log.grant_rejected", at, { reason: parsed.reason, code: parsed.code, grant_kind: parsed.grant_kind, participant_id: parsed.participant_id ?? undefined, api_key_id: parsed.api_key_id ?? undefined }));
    } else if (parsed.event === "webhook.delivery.complete_failed") {
      rows.push(row("webhook.log.complete_failed", at, { attempt_id: parsed.attempt_id, webhook_delivery_id: parsed.delivery_id, http_status: parsed.http_status ?? undefined, http_status_class: parsed.http_status_class ?? undefined, error_code: parsed.error_code ?? undefined, journey_id: parsed.journey_id ?? undefined }));
    }
  }
  return rows;
}

/** @param {string[]} argv */
export async function main(argv) {
  const arg = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const tenant = arg("tenant");
  const fromMs = Number(arg("from"));
  const toMs = Number(arg("to"));
  const apiLog = arg("api-log");
  if (!tenant || !UUID.test(tenant) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    process.stderr.write("usage: webhooks.mjs --tenant <uuid> --from <ms> --to <ms> [--api-log <path>]\n");
    process.exit(2);
  }
  TENANT = tenant;
  const rows = await dbRows(fromMs, toMs);
  const combined = apiLog ? [...rows, ...logRows(apiLog)] : rows;
  process.stdout.write(`${JSON.stringify(combined.sort((a, b) => (a.est_server_ms ?? 0) - (b.est_server_ms ?? 0) || (a.seq ?? 0) - (b.seq ?? 0)), null, 1)}\n`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}
