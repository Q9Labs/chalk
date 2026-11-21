// @ts-check
/**
 * Shared machinery for the slice-10 recording fixture chains. A fault scenario (hop a) hands off, per
 * run, the telemetry rows its isolated-Postgres world stands for; the join test (hop b) assembles the
 * positive and healthy fixtures from those row files and proves the symptom's rule against them.
 *
 * A captured world carries `observations` (the evidence reader's internal shape) and `watermarks`. A
 * fixture carries telemetry `rows`: the registry envelope (`kind`, `name`, `event_id`, `est_server_ms`,
 * subject ids) plus the event's value fields — the shape the row adapter turns back into observations
 * in observability/fixtures and in production diagnosis alike.
 *
 * The conversion is exact where the reader saw a point record and reconstructive where it saw a
 * snapshot: a db observation's window runs from the row's creation to the read instant, so the row it
 * stands for carries `est_server_ms` at the window's start and `duration_ms` spanning to the read,
 * which the adapter reads back as the same window.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** The registry's fact and event tables, for claim fields and event names. */
const registry = JSON.parse(readFileSync(join(ROOT, "observability/generated/registry.json"), "utf8"));
/** @type {Map<string, { event: string, claim: string }>} keyed by `${fact}|${source}` — every mapped event, own event first */
const EVENT_OF = new Map();
const EVENTS_OF = new Map();
for (const fact of registry.facts)
  for (const event of fact.events) {
    const key = `${fact.name}|${event.source}`;
    EVENTS_OF.set(key, [...(EVENTS_OF.get(key) ?? []), { event: event.event, claim: event.claim }]);
    EVENT_OF.set(key, { event: event.event, claim: event.claim });
  }
/** @type {Map<string, string>} event name -> record kind */
const KIND_OF = new Map(registry.events.map((event) => [event.name, event.kind]));

/** The evidence sources whose rows a chain names in file order; others fold into `witness`. */
const ROW_SOURCES = ["db", "api", "sfu", "recorder", "client", "web", "r2", "lambda"];

/**
 * A captured observation to its telemetry row: the registry envelope plus every value field the
 * reader recorded. Subject ids come from the observation's subject (envelope) or fall back to the
 * value's own id field, whichever the reader populated. `est_server_ms` sits at the observation
 * window's start and `duration_ms` carries its length, so the row adapter reconstructs the window
 * exactly. When the value lacks the event's claim field — a `none` claim the reader knows but the raw
 * row could not carry — the claim is stamped from the observation.
 * @param {any} o the captured observation
 * @param {string | undefined} tenant the declared tenant, for coverage rows that captured none of their own
 * @returns {Record<string, unknown>}
 */
export function rowOf(o, tenant = o.subject?.tenant) {
  const candidates = EVENTS_OF.get(`${o.fact}|${o.source}`) ?? [];
  const entry = candidates.find((candidate) => candidate.event === o.value?.event) ?? EVENT_OF.get(`${o.fact}|${o.source}`);
  assert(entry, `${o.fact} from ${o.source} names no registry event: the world's evidence predates the registry`);
  const row = { ...o.value };
  row.kind = KIND_OF.get(entry.event);
  row.name = entry.event;
  row.event_id = o.id;
  row.est_server_ms = o.window.from_ms;
  const duration = o.window.to_ms - o.window.from_ms;
  if (duration > 0) row.duration_ms = duration;
  for (const [key, field] of [
    ["tenant", "tenant_id"],
    ["episode", "episode_id"],
    ["participant", "participant_id"],
    ["connection", "media_connection_id"],
    ["attempt", "client_session_id"],
    ["job", "job_id"],
    ["space", "space_id"],
    ["recording", "recording_id"],
  ]) {
    if (row[field] === undefined && o.subject?.[key] !== undefined) row[field] = o.subject[key];
  }
  if (row.tenant_id === undefined && tenant !== undefined) row.tenant_id = tenant;
  if (row[entry.claim] === undefined) row[entry.claim] = o.claim;
  if (typeof o.origin === "string" && o.origin.startsWith("decision:")) row.decision_id = o.origin.slice("decision:".length);
  return row;
}

/**
 * The rows one captured item produced, grouped by source into the chain's hand-off files.
 * @param {any} world the captured world
 * @param {string} item the item id inside `world.evidence`
 * @returns {Map<string, Record<string, unknown>[]>} `<source>-rows` name -> rows, sorted for a stable replay
 */
export function itemRows(world, item) {
  const observations = world.evidence[item]?.observations;
  assert(Array.isArray(observations), `world has no evidence for item ${item}`);
  /** @type {Map<string, Record<string, unknown>[]>} */
  const files = new Map();
  for (const o of observations) {
    const file = `${o.source}-rows`;
    files.set(file, [...(files.get(file) ?? []), rowOf(o)]);
  }
  for (const rows of files.values()) rows.sort(byRow);
  return files;
}

/**
 * The coverage rows one symptom's positive run adds: the claim-sweep lines and the synthetic rows for
 * declared events and fields the run never produced. Sweeps bind to nothing; synthetic rows name
 * minted ids, so a check can never read them as the item's own evidence.
 * @param {string} code the symptom code
 * @param {any} coverage the recording.coverage.mjs default export
 * @param {{ asof_ms: number, tenant: string }} at the fixture's as-of and tenant for stamping
 * @returns {{ witness: Record<string, unknown>[], coverage: Record<string, unknown>[] }}
 */
export function coverageRows(code, coverage, { asof_ms, tenant }) {
  const needs = coverage.needs[code];
  assert(needs, `${code} declares no coverage needs`);
  /** @type {Record<string, unknown>[]} */
  const witness = [];
  for (const key of needs.sweep) {
    const o = coverage.sweep[key];
    assert(o, `coverage has no sweep row ${key}`);
    witness.push(rowOf(o, tenant));
  }
  /** @type {Record<string, unknown>[]} */
  const extra = [];
  for (const key of needs.synthetic) {
    const o = coverage.synthetic[key];
    assert(o, `coverage has no synthetic row ${key}`);
    const stamped = stampSynthetic(o, { asof_ms, tenant });
    extra.push(rowOf(stamped, tenant));
  }
  witness.sort(byRow);
  extra.sort(byRow);
  return { witness, coverage: extra };
}

/**
 * A synthetic observation stamped at the fixture's as-of: `at`/`est_server_ms: "asof"` placeholders
 * become the time, the window becomes the point, the event id is minted from the row's shape, and the
 * subject gains the declared tenant.
 * @param {any} o the synthetic observation template
 * @param {{ asof_ms: number, tenant: string }} at
 */
function stampSynthetic(o, { asof_ms, tenant }) {
  const stamp = (value) => (value === "asof" ? asof_ms : value);
  const value = Object.fromEntries(Object.entries(o.value).map(([k, v]) => [k, stamp(v)]));
  const subject = { tenant, ...o.subject };
  return {
    id: `syn_${keyOf(o)}`,
    fact: o.fact,
    source: o.source,
    origin: `synthetic:${o.source}`,
    subject,
    window: { from_ms: asof_ms, to_ms: asof_ms },
    claim: o.claim,
    value,
    failure: false,
  };
}

/** @param {any} o */
const keyOf = (o) =>
  createHash("sha256")
    .update(`${o.fact}|${o.source}|${o.claim}|${JSON.stringify(o.subject)}`)
    .digest("hex")
    .slice(0, 32);

/** Stable row order inside a hand-off file: event, then time, then id. */
const byRow = (a, b) => String(a.name).localeCompare(String(b.name)) || Number(a.est_server_ms) - Number(b.est_server_ms) || String(a.event_id).localeCompare(String(b.event_id));

/**
 * The canonical chain-file list for one run: the item's own rows by source, then the witness and
 * coverage files the positive run adds. File order inside `fixture.chain` is the concatenation order
 * the gate compares `fixture.rows` against.
 * @param {Map<string, Record<string, unknown>[]>} files item rows grouped by `<source>-rows`
 * @param {{ witness: Record<string, unknown>[], coverage: Record<string, unknown>[] }} extra
 * @param {string} run `positive` or `healthy`
 */
export function chainFiles(files, extra, run) {
  /** @type {[string, Record<string, unknown>[]][]} */
  const named = [];
  for (const source of ROW_SOURCES) {
    const rows = files.get(`${source}-rows`);
    if (rows && rows.length > 0) named.push([`${source}-rows.${run}.json`, rows]);
  }
  if (extra.witness.length > 0) named.push([`witness-rows.${run}.json`, extra.witness]);
  if (extra.coverage.length > 0) named.push([`coverage-rows.${run}.json`, extra.coverage]);
  return named;
}

/**
 * Writes or checks a set of hand-off files under the chain directory: `CHALK_CHAIN_WRITE=1` writes
 * them (the hop's `writes` contract); a plain run compares them with the committed files, so a stale
 * or hand-edited hand-off fails the test.
 * @param {string} dir absolute chain directory
 * @param {[string, Record<string, unknown>[]][]} named [file, rows]
 */
export function writeOrCompareRows(dir, named) {
  if (process.env.CHALK_CHAIN_WRITE === "1") {
    // A hand-off names every row file the hop emits for its runs; a file no longer emitted for those
    // runs is stale and must go, or the join would replay two generations of rows against each other.
    mkdirSync(dir, { recursive: true });
    const wanted = new Set(named.map(([name]) => name));
    const runs = new Set(named.map(([name]) => name.match(/-rows\.(\w+)\.json$/)?.[1]).filter(Boolean));
    for (const name of readdirSync(dir)) {
      const run = name.match(/-rows\.(\w+)\.json$/)?.[1];
      if (run !== undefined && runs.has(run) && !wanted.has(name)) rmSync(join(dir, name));
    }
  }
  for (const [name, rows] of named) {
    const path = join(dir, name);
    if (process.env.CHALK_CHAIN_WRITE === "1") {
      writeFileSync(path, `${JSON.stringify(rows, null, 1)}\n`);
    } else {
      assert(existsSync(path), `chain file ${name} is missing: run this test with CHALK_CHAIN_WRITE=1`);
      assert.deepStrictEqual(JSON.parse(readFileSync(path, "utf8")), JSON.parse(JSON.stringify(rows)), `chain file ${name} is stale: run this test with CHALK_CHAIN_WRITE=1`);
    }
  }
}

/**
 * Writes or checks one fixture JSON the same way the hop contract requires.
 * @param {string} path absolute fixture path
 * @param {Record<string, unknown>} fixture
 */
export function writeOrCompareFixture(path, fixture) {
  if (process.env.CHALK_CHAIN_WRITE === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(fixture, null, 1)}\n`);
  } else {
    assert(existsSync(path), `fixture ${path} is missing: run the chain with CHALK_CHAIN_WRITE=1`);
    assert.deepStrictEqual(JSON.parse(readFileSync(path, "utf8")), JSON.parse(JSON.stringify(fixture)), `fixture ${path} is stale: run the chain with CHALK_CHAIN_WRITE=1`);
  }
}
