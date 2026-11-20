// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * The live stores behind `diagnose --live`: Postgres for the declaration, the telemetry ledger (through `telemetry-watermarks`) for
 * client watermarks, and Axiom for rows and server watermarks. Every read is read-only. world.mjs turns what they return into a World.
 *
 * Environment: CHALK_DATABASE_URL (read-only), AXIOM_TOKEN, AXIOM_ORG_ID (personal tokens), CHALK_LOG_DATASET. The registry's
 * datasets (lifecycle, requests, media-stats, infra, logs) all land in the environment's one log dataset today, so that is the one
 * read. Values never go on a command line: psql reads PG* variables and the Go command reads its environment.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { axiom, quote } from "../axiom.mjs";
import { connectionEnv } from "../database.mjs";
import { liveWorld } from "./world.mjs";

/** @typedef {import("./world.mjs").DbEpisode} DbEpisode */
/** @typedef {import("./world.mjs").Ledger} Ledger */
/** @typedef {{ tenant: string, episode: string }} Target */
/**
 * @typedef {{
 *   declaration(target: Target): Promise<DbEpisode | null>,
 *   ledger(target: Target): Promise<Ledger>,
 *   rows(episode: string, window: { from_ms: number, to_ms: number }): Promise<Readonly<Record<string, any>>[]>,
 * }} Stores
 */

const run = promisify(execFile);
const API_DIR = fileURLToPath(new URL("../../../apps/api", import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A store the command needs is missing or refused the read. */
export class StoreError extends Error {}

/**
 * Opens the World of one Episode.
 * @param {Target} target
 * @param {Stores} stores
 * @param {{ now?: number }} options
 */
export async function openLive(target, stores, { now = Date.now() }) {
  for (const [name, id] of Object.entries(target)) if (!UUID.test(id)) throw new StoreError(`--live needs --${name} <uuid>, got ${JSON.stringify(id.slice(0, 40))}`);
  const db = await stores.declaration(target);
  if (db === null) throw new StoreError(`no Episode ${target.episode} in tenant ${target.tenant}`);
  // Query by ingest time through now, so late uploads can fill seqs. The
  // proof rules select witnesses by their event intervals, including clock error.
  const window = { from_ms: Date.parse(db.episode.created_at), to_ms: now };
  const [ledger, rows] = await Promise.all([stores.ledger(target), stores.rows(target.episode, window)]);
  return liveWorld({ db, ledger, rows, asof_ms: now });
}

/**
 * A fixed message for a failed psql run. psql's stderr names the database user, host and port when it cannot connect, so it is never
 * printed, the way telemetry-watermarks redacts the same failure. psql exits 2 when the connection fails (authentication included)
 * and 3 when the query fails under ON_ERROR_STOP.
 * @param {{ code?: unknown }} error
 */
export function psqlFailure(error) {
  if (error.code === "ENOENT") return "psql is not installed";
  if (error.code === 2) return "connect to the declaration database failed";
  if (error.code === 3) return "the declaration query failed";
  return `psql failed (exit ${String(error.code)})`;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof fetch} [fetchImpl]
 * @returns {Stores}
 */
export function realStores(env, fetchImpl = fetch) {
  const need = (/** @type {string} */ name) => {
    const value = env[name];
    if (!value) throw new StoreError(`--live needs ${name}`);
    return value;
  };
  const databaseUrl = () => need("CHALK_DATABASE_URL");
  const ask = (/** @type {string} */ apl, /** @type {{ from_ms: number, to_ms: number }} */ window) =>
    axiom({ token: need("AXIOM_TOKEN"), org: env.AXIOM_ORG_ID, dataset: need("CHALK_LOG_DATASET"), apl, start: window.from_ms, end: window.to_ms, signal: AbortSignal.timeout(60_000) }, fetchImpl).catch((error) => {
      if (error instanceof StoreError) throw error;
      const status = error instanceof Error ? /^Axiom answered HTTP (\d{3})\b/u.exec(error.message)?.[1] : null;
      throw new StoreError(status ? `Axiom refused the read (HTTP ${status})` : "Axiom log read failed");
    });
  return {
    async declaration({ tenant, episode }) {
      const url = databaseUrl();
      // libpq has no default roots to verify a server against; use the system's unless the URL or the caller names a file.
      const params = new URL(url).searchParams;
      const roots = String(params.get("sslmode")).startsWith("verify-") && !params.has("sslrootcert") && !env.PGSSLROOTCERT ? { PGSSLROOTCERT: "system" } : {};
      const pg = { ...connectionEnv(url, env), ...roots };
      const { stdout } = await run("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", declarationSql(tenant, episode)], { env: pg, maxBuffer: 16 << 20 }).catch((error) => {
        throw new StoreError(`Postgres refused the declaration read: ${psqlFailure(error)}`);
      });
      const parsed = JSON.parse(stdout.trim());
      return parsed.episode === null ? null : parsed;
    },
    async ledger({ tenant, episode }) {
      try {
        const { stdout } = await run("go", ["-C", API_DIR, "run", "./cmd/telemetry-watermarks", "--tenant", tenant, "--episode", episode], { env: { ...env, CHALK_DATABASE_URL: databaseUrl() }, maxBuffer: 64 << 20 });
        return JSON.parse(stdout);
      } catch (error) {
        // An unreadable ledger leaves every seat's client source not read, which keeps those seats unchecked; it never reads as complete.
        const stderr = String(/** @type {{ stderr?: string }} */ (error).stderr ?? /** @type {Error} */ (error).message).trim();
        const lines = stderr.split("\n");
        return { unavailable: lines.findLast((line) => line.startsWith("telemetry-watermarks:")) ?? lines.at(-1) ?? "telemetry-watermarks failed" };
      }
    },
    async rows(episode, window) {
      return readAll((part) => ask(`where ['attributes.episode_id'] == ${quote(episode)}`, part), window);
    },
  };
}

/**
 * Reads every row of a window. Axiom caps one answer, so a capped window is split in half until each half fits; rows on a shared
 * boundary are kept once by their row id.
 * @param {(window: { from_ms: number, to_ms: number }) => Promise<{ rows: Record<string, any>[], truncated: boolean }>} query
 * @param {{ from_ms: number, to_ms: number }} window
 * @returns {Promise<Record<string, any>[]>}
 */
async function readAll(query, window) {
  const { rows, truncated } = await query(window);
  if (!truncated) return rows;
  if (window.to_ms - window.from_ms <= 1) throw new StoreError(`more rows than Axiom returns in one answer within 1 ms at ${new Date(window.from_ms).toISOString()}`);
  const mid = Math.floor((window.from_ms + window.to_ms) / 2);
  const halves = [...(await readAll(query, { from_ms: window.from_ms, to_ms: mid })), ...(await readAll(query, { from_ms: mid, to_ms: window.to_ms }))];
  return [...new Map(halves.map((row, index) => [row._rowId ?? `#${index}`, row])).values()];
}

/**
 * The Episode, its tenant and its seats as one JSON object, or `{"episode": null}` when the tenant holds no such Episode.
 * @param {string} tenant
 * @param {string} episode
 */
function declarationSql(tenant, episode) {
  return `with ep as (select * from episodes where id = ${quote(episode)}::uuid and tenant_id = ${quote(tenant)}::uuid)
select json_build_object(
  'episode', (select json_build_object('id', ep.id, 'tenant', ep.tenant_id, 'space', ep.space_id, 'created_at', ep.created_at, 'started_at', ep.started_at, 'ended_at', ep.ended_at, 'end_reason', ep.end_reason) from ep),
  'tenant', (select json_build_object('id', t.id, 'name', t.name) from tenants t join ep on ep.tenant_id = t.id),
  'seats', coalesce((select json_agg(json_build_object(
      'participant', p.id, 'name', p.name, 'role', p.role, 'capabilities', p.capabilities, 'generation', p.generation, 'connection', p.media_connection_id,
      'created_at', p.created_at, 'joined_at', p.joined_at, 'left_at', p.left_at, 'account', p.account_id,
      'identity', case when i.id is null then null else json_build_object('id', i.id, 'kind', i.kind, 'name', i.display_name) end
    ) order by p.created_at, p.id)
    from ep join participants p on p.episode_id = ep.id and p.tenant_id = ep.tenant_id
    left join identities i on i.id = p.identity_id and i.tenant_id = p.tenant_id), '[]'::json))`;
}
