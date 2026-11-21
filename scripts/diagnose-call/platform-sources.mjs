// @ts-check
// fallow-ignore-file complexity -- platform reads fold many event shapes into one world; the fixture worlds and the fault runs cover each branch.
/**
 * The platform's live reads behind `diagnose platform <environment> <UTC date> --live`. All of the slice's datasets land in the
 * environment's one log dataset today, so the reads filter it by `env` and event name; each read that fails becomes a coverage gap
 * on the sources it feeds, never a zero. Postgres still owns `media_plane_changes`, and the adapter mints three reader-side
 * events the registry declares from what the stores return:
 *
 * - `api.service_version` and `sync.service_version` from server rows that carry a version but are not `api.http_request` rows
 *   (the request rows already witness `release.running` directly);
 * - `db.media_plane_change` from the `media_plane_changes` table, which the API's kill-switch trigger writes.
 *
 * The output is a fixture-world `World`, so `openWorld` in proof/fixture-world.mjs runs the same check ports over it.
 */
import { quote } from "./axiom.mjs";
import { FACTS, SOURCE_TABLE } from "./proof/facts.mjs";
import { observationsFromRows } from "./proof/rows.mjs";
import { unwrapRow } from "./live/world.mjs";
import { ITEM } from "./proof/profile.mjs";
import { StoreError } from "./live/stores.mjs";

/** @typedef {import("./proof/fixture-world.mjs").World} World */
/** @typedef {import("./proof/evidence.mjs").Watermark} Watermark */

const DAY_MS = 86_400_000;

/** Event names the platform facts read, plus the host collector's alert rows. */
const PLATFORM_ROW_NAMES = [
  "db.health_sample",
  "api.http_request",
  "obs.flags_snapshot",
  "client.flags_snapshot",
  "release.marker",
  "release.started",
  "edge.http_rollup",
  "edge.collector_tick",
  "edge.uptime_check",
];
const PLATFORM_ALERT_RULES = ["database-unreachable", "runtime-health"];

/**
 * The APL the day read runs: every kernel-named row the platform facts witness, every host alert row, and rows carrying a service
 * version (the reader mints `*.service_version` from them). `env` binds the read to the item's environment.
 * @param {string} environment
 */
export function platformApl(environment) {
  const env = `where ['env'] == ${quote(environment)}`;
  const names = PLATFORM_ROW_NAMES.map((name) => `['name'] == ${quote(name)}`).join(" or ");
  const rules = PLATFORM_ALERT_RULES.map((rule) => `['chalk_alert_rule'] == ${quote(rule)}`).join(" or ");
  return `${env} | where ${names} or ${rules} or isnotnull(['service_version']) or isnotnull(['service.version'])`;
}

/**
 * One UTC day of one environment as a World: the declaration and the observations/watermarks the stores read. `rows` are Axiom's
 * raw `_time`/attributes rows, `mediaPlaneChanges` Postgres rows, and `readFailures` names each dataset read that did not
 * complete so the sources it feeds stay uncovered rather than reading as empty.
 * @param {{ environment: string, day: string, rows: Readonly<Record<string, any>>[], mediaPlaneChanges: Readonly<Record<string, any>>[], readFailures?: readonly string[], asof_ms: number }} input
 * @returns {{ world: World, notes: string[] }}
 */
export function platformWorld({ environment, day, rows, mediaPlaneChanges, readFailures = [], asof_ms }) {
  const from_ms = Date.parse(`${day}T00:00:00.000Z`);
  const to_ms = from_ms + DAY_MS;
  /** @type {Record<string, any>[]} */
  const minted = [];
  const flat = [];
  for (const raw of rows) {
    const row = hostRow(unwrapRow(raw), environment);
    flat.push(row);
    const version = serviceVersion(row);
    if (version !== null) minted.push(version);
  }
  for (const [index, change] of mediaPlaneChanges.entries()) {
    const changed = Date.parse(String(change.changed_at ?? change.changed_at_ms ?? ""));
    if (!Number.isFinite(changed)) continue;
    minted.push({
      kind: "fact",
      name: "db.media_plane_change",
      event_id: `minted:mpc:${index}:${String(change.id ?? changed)}`,
      est_server_ms: changed,
      env: environment,
      media_plane_scope: String(change.scope ?? change.media_plane_scope ?? ""),
      old_plane: String(change.old_plane ?? change.old ?? ""),
      new_plane: String(change.new_plane ?? change.new ?? ""),
      changed_at_ms: changed,
    });
  }
  const { observations, dropped } = observationsFromRows([...flat, ...minted]);
  const covered = readFailures.length === 0;
  const watermarks = platformSources().map((source) => ({
    source,
    subject: ITEM,
    complete_to_ms: covered ? Math.min(asof_ms, to_ms) : null,
    evidence_gaps: readFailures.map((reason) => ({ from_ms, to_ms, reason })),
    emits: emitsOf(source),
    build: covered ? `${source} (live read)` : `${source} (read failed)`,
  }));
  /** @type {import("./proof/profile.mjs").PlatformDeclaration} */
  const declaration = { kind: "platform", id: environment, tenant: null, day, window: { from_ms, to_ms } };
  const world = {
    asof_ms,
    tenants: [],
    people: [],
    declarations: [declaration],
    sessions: [],
    evidence: { [environment]: { observations, watermarks } },
    history: [],
  };
  const notes = [
    `platform ${environment} ${day}: ${flat.length} rows read, ${observations.length} observations, ${minted.length} reader-minted rows`,
    ...readFailures.map((what) => `read gap: ${what}`),
    ...dropped.slice(0, 3).map((row) => `dropped ${row.event}: ${row.why}`),
  ];
  return { world, notes };
}

/** The sources any platform fact is witnessed by. */
function platformSources() {
  const sources = new Set();
  for (const def of Object.values(FACTS)) for (const event of def.events) sources.add(event.source);
  return [...sources].sort();
}

/** The facts one source's build can emit, from the registry. @param {string} source */
function emitsOf(source) {
  return Object.entries(FACTS)
    .filter(([, def]) => def.events.some((event) => event.source === source))
    .map(([fact]) => fact);
}

/**
 * A host collector row is the only row that arrives without the kernel envelope: its `_time` is its time, its alert value is its
 * claim, and the read's environment is where it belongs. The projection keeps the row's own words (`chalk_alert_*` stay) while
 * giving it the citation and claim fields the registry events declare.
 * @param {Record<string, any>} row
 * @param {string} environment
 */
function hostRow(row, environment) {
  if (typeof row.chalk_alert_rule !== "string") return row;
  const reach = Number(row.chalk_alert_value) === 1 ? "down" : "up";
  return {
    ...row,
    event_id: typeof row.event_id === "string" ? row.event_id : `host:${String(row._rowId ?? `${row.chalk_alert_rule}:${row._time ?? row.est_server_ms}`)}`,
    est_server_ms: typeof row.est_server_ms === "number" ? row.est_server_ms : Date.parse(String(row._time ?? "")),
    env: row.env ?? environment,
    ...(row.chalk_alert_rule === "database-unreachable" ? { db_reach: reach } : {}),
    ...(row.chalk_alert_rule === "runtime-health" ? { origin_reach: reach } : {}),
  };
}

/**
 * One `*.service_version` row for a server row that carries a version but is not an `api.http_request` (those already carry the
 * fact directly). Rows without an event id still mint one: the minted id is citable the same way.
 * @param {Record<string, any>} row
 */
function serviceVersion(row) {
  const version = row.service_version ?? row["service.version"];
  if (typeof version !== "string" || version === "" || row.name === "api.http_request" || row.name === "api.service_version" || row.name === "sync.service_version") return null;
  const service = String(row.service ?? row.service_name ?? "");
  const name = service.includes("sync") ? "sync.service_version" : service.includes("api") ? "api.service_version" : null;
  if (name === null || typeof row.est_server_ms !== "number") return null;
  return {
    kind: "fact",
    name,
    event_id: `minted:sv:${String(row.event_id ?? `${name}:${row.est_server_ms}:${version}`)}`,
    est_server_ms: row.est_server_ms,
    env: row.env,
    service_version: version,
  };
}

/**
 * Reads one platform day through the live stores: Axiom for the telemetry rows and psql for `media_plane_changes`. Each read is
 * tolerant: a refused Axiom read becomes a source gap, a refused Postgres read drops the change anchors but is named in notes.
 * @param {{ environment: string, day: string }} target
 * @param {import("./live/stores.mjs").Stores & { platformRows?(env: string, window: { from_ms: number, to_ms: number }): Promise<Readonly<Record<string, any>>[]>, mediaPlaneChanges?(window: { from_ms: number, to_ms: number }): Promise<Readonly<Record<string, any>>[]> }} stores
 * @param {{ now?: number }} [options]
 */
export async function openPlatformLive(target, stores, { now = Date.now() } = {}) {
  const from_ms = Date.parse(`${target.day}T00:00:00.000Z`);
  const window = { from_ms, to_ms: Math.min(now, from_ms + DAY_MS) };
  /** @type {string[]} */
  const readFailures = [];
  const rows = await (stores.platformRows ? stores.platformRows(target.environment, window) : Promise.reject(new StoreError("the store has no platform read"))).catch((error) => {
    readFailures.push(error instanceof StoreError ? error.message : "the platform row read failed");
    return [];
  });
  const mediaPlaneChanges = await (stores.mediaPlaneChanges ? stores.mediaPlaneChanges(window) : Promise.resolve([])).catch(() => {
    readFailures.push("media_plane_changes could not be read");
    return [];
  });
  return platformWorld({ environment: target.environment, day: target.day, rows: [...rows], mediaPlaneChanges: [...mediaPlaneChanges], readFailures, asof_ms: now });
}
