// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * The row adapter: telemetry rows (registry envelope plus event fields, as Axiom returns them) to the kernel's observations, and the
 * one way a symptom's fixture is judged. The registry says which events witness which fact (an area file's `facts`), so this file
 * holds no per-symptom mapping: a slice that declares a fact and its events gets its rows read here.
 *
 * A row names its registry event one way: a kernel row (the Go, SFU and Sync kernels' `send`, and the API's row of a client
 * kernel's record) carries its record `kind` and the event in `name`. A row an older emitter still writes is read only through
 * its event's `legacy.match` in the registry, such as an `sdk.telemetry` row of type `call_ended` from an SDK release before the
 * client kernel. `eventOf` is the one place a row's event is read, for fixtures and live rows alike.
 *
 * A row becomes one observation per fact whose events list it. A row that can't be placed is dropped and returned with the reason,
 * never guessed: no `event_id` means it can't be cited, and no `est_server_ms` means its time is unknown, so the subject it would
 * have witnessed stays unchecked.
 */
import { readFileSync } from "node:fs";
import { FACTS, RECORD_KINDS, SOURCE_TABLE } from "./facts.mjs";
import { observation, origin } from "./evidence.mjs";
import { openBundle } from "./bundle.mjs";
import { ITEM, profileFor, seatKey, sessionKey } from "./profile.mjs";
import { judge, rulesVersion } from "./verdict.mjs";

/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */
/** @typedef {import("./profile.mjs").Declaration} Declaration */
/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./verdict.mjs").Verdict} Verdict */
/** @typedef {Readonly<Record<string, unknown>>} Row */
/** @typedef {{ description: string, asof_ms: number, declaration: Declaration, rows: Row[], watermarks?: Watermark[] }} Fixture */

/** Envelope ids, and the subject key each one sets. */
const SUBJECT_FIELDS = /** @type {const} */ ([
  ["episode_id", "episode"],
  ["participant_id", "participant"],
  ["generation", "generation"],
  ["media_connection_id", "connection"],
  ["client_session_id", "attempt"],
  ["job_id", "job"],
  ["space_id", "space"],
  ["tenant_id", "tenant"],
  ["env", "environment"],
]);
/** Fields that place or name a row rather than describe what it measured. */
const NOT_VALUES = new Set([...SUBJECT_FIELDS.map(([field]) => field), "event", "kind", "name", "event_id", "est_server_ms", "clock_err_ms", "clock_state", "duration_ms", "decision_id"]);

/** @type {ReadonlyMap<string, readonly { fact: string, source: string, claim: string, failure_claims: readonly string[] }[]>} */
const BY_EVENT = (() => {
  /** @type {Map<string, { fact: string, source: string, claim: string, failure_claims: readonly string[] }[]>} */
  const map = new Map();
  for (const [fact, def] of Object.entries(FACTS)) {
    for (const event of def.events) map.set(event.event, [...(map.get(event.event) ?? []), { fact, source: event.source, claim: event.claim, failure_claims: event.failure_claims ?? [] }]);
  }
  return map;
})();

const registry = JSON.parse(readFileSync(new URL("../../../observability/generated/registry.json", import.meta.url), "utf8"));
/** Registry events an older emitter still writes under another shape, with the fields and values that pick its rows out. */
const LEGACY = registry.events.flatMap((/** @type {{ name: string, legacy?: { match?: Record<string, string> } }} */ event) => (event.legacy?.match ? [{ name: event.name, match: Object.entries(event.legacy.match) }] : []));

/**
 * The registry event a row records: `name` on a kernel row of a registry record kind, else the event whose legacy match the row
 * fits, else none.
 * @param {Row} row
 * @returns {string | undefined}
 */
export function eventOf(row) {
  if (typeof row.name === "string" && RECORD_KINDS.includes(String(row.kind))) return row.name;
  return LEGACY.find((entry) => entry.match.every(([field, value]) => row[field] === value))?.name;
}

/** @param {string} eventId */
const rowQuery = (eventId) => `axiom chalk-logs | search ${JSON.stringify(eventId)}`;

/**
 * The sources a row witnesses for, from the registry: an empty list means no fact reads it.
 * @param {Row} row
 * @returns {string[]}
 */
export function rowSources(row) {
  const event = eventOf(row);
  const witnessed = event === undefined ? undefined : BY_EVENT.get(event);
  return [...new Set((witnessed ?? []).map((entry) => entry.source))];
}

/**
 * @param {readonly Row[]} rows
 * @returns {{ observations: Readonly<Observation>[], dropped: { index: number, event: unknown, why: string }[] }}
 */
export function observationsFromRows(rows) {
  /** @type {Readonly<Observation>[]} */
  const observations = [];
  /** @type {{ index: number, event: unknown, why: string }[]} */
  const dropped = [];
  rows.forEach((row, index) => {
    const event = eventOf(row);
    const witnessed = event === undefined ? undefined : BY_EVENT.get(event);
    if (!witnessed) return;
    const unplaced = unplacedWhy(row);
    if (unplaced !== null) return void dropped.push({ index, event, why: unplaced });
    for (const entry of witnessed) {
      const placed = observationOf(row, entry);
      if (typeof placed === "string") dropped.push({ index, event, why: placed });
      else observations.push(placed);
    }
  });
  return { observations, dropped };
}

/** Why a row can't be placed at all, or null. @param {Row} row */
const unplacedWhy = (row) => {
  if (typeof row.event_id !== "string" || row.event_id === "") return "no event_id, so it can't be cited";
  if (typeof row.est_server_ms !== "number") return "no est_server_ms, so its time is unknown";
  return null;
};

/**
 * One row's observation of one fact, or why the row says nothing about it.
 * @param {Row} row a row `unplacedWhy` accepted
 * @param {{ fact: string, source: string, claim: string, failure_claims: readonly string[] }} entry
 * @returns {Readonly<Observation> | string}
 */
function observationOf(row, { fact, source, claim, failure_claims }) {
  const claimed = row[claim];
  if (claimed === undefined || claimed === null) return `no ${claim}, the field ${fact} compares`;
  const at = /** @type {number} */ (row.est_server_ms);
  const err = typeof row.clock_err_ms === "number" ? row.clock_err_ms : 0;
  const window = typeof row.duration_ms === "number" ? { from_ms: at, to_ms: at + row.duration_ms } : { from_ms: at - err, to_ms: at + err };
  /** @type {Record<string, string | number>} */
  const subject = {};
  for (const [field, key] of SUBJECT_FIELDS) if (typeof row[field] === "string" || typeof row[field] === "number") subject[key] = /** @type {string | number} */ (row[field]);
  /** @type {Record<string, string | number | boolean>} */
  const value = {};
  for (const [name, field] of Object.entries(row)) if (!NOT_VALUES.has(name) && (typeof field === "string" || typeof field === "number" || typeof field === "boolean")) value[name] = field;
  const id = String(row.event_id);
  return observation({
    id,
    fact,
    source,
    origin: typeof row.decision_id === "string" ? origin.decision(row.decision_id) : origin.measured(source, typeof row.client_session_id === "string" ? row.client_session_id : undefined),
    subject,
    window,
    claim: String(claimed),
    value,
    failure: failure_claims.includes(String(claimed)),
    query: rowQuery(id),
  });
}

/**
 * The watermarks a fixture stands for when it gives none: every source the checks read is complete to `asof_ms` with no gap and
 * emits every fact the registry lets it emit, one per seat for a per-seat source (one per client session on an attempt, which has no
 * seat yet).
 * @param {Declaration} declaration
 * @param {readonly CheckDef[]} catalogue
 * @param {number} asof_ms
 * @returns {Watermark[]}
 */
export function completeWatermarks(declaration, catalogue, asof_ms) {
  const sources = new Set(catalogue.flatMap((def) => [...def.requires, ...def.optional].flatMap((requirement) => requirement.from)));
  const perSeat = new Set(SOURCE_TABLE.filter((entry) => entry.per_seat).map((entry) => entry.source));
  const seats = declaration.kind === "episode" ? declaration.seats.map((seat) => seatKey(seat.participant)) : declaration.kind === "attempt" ? [sessionKey(declaration.id)] : [];
  return [...sources].sort().flatMap((source) => {
    const emits = Object.entries(FACTS)
      .filter(([, def]) => def.events.some((event) => event.source === source))
      .map(([fact]) => fact);
    return (perSeat.has(source) ? seats : [ITEM]).map((subject) => ({ source, subject, complete_to_ms: asof_ms, evidence_gaps: [], emits, build: `${source} fixture` }));
  });
}

/**
 * Judges a fixture with one symptom's check, the way the coverage gate and fault scenarios prove a rule.
 * @param {Fixture} fixture
 * @param {readonly CheckDef[]} catalogue
 * @param {string} code
 * @returns {{ verdict: Verdict, dropped: { index: number, event: unknown, why: string }[] }}
 */
export function judgeFixture(fixture, catalogue, code) {
  const only = catalogue.filter((def) => def.code === code);
  if (only.length === 0) throw new TypeError(`no check ${code} in the catalogue: add observability/rules/${code}.mjs`);
  const bundle = openBundle(profileFor(fixture.declaration, only, fixture.asof_ms), { asof_ms: fixture.asof_ms });
  const { observations, dropped } = observationsFromRows(fixture.rows);
  for (const o of observations) bundle.add(o);
  for (const w of fixture.watermarks ?? completeWatermarks(fixture.declaration, only, fixture.asof_ms)) bundle.watermark(w);
  return { verdict: judge(bundle.seal(), only, { rules: rulesVersion(only, []), prior: null }), dropped };
}

/**
 * What a fixture proves about its symptom's rule, separate from the item's outcome: the item also needs the kernel's own backstops
 * read (problem reports for BLIND_SPOT), which a one-symptom fixture doesn't declare.
 * @param {Verdict} verdict
 * @param {string} code
 * @returns {{ findings: number, checked: number, eligible: number }}
 */
export function ruleResult(verdict, code) {
  const { checked, eligible } = verdict.coverage.by_code[code] ?? { checked: 0, eligible: 0 };
  return { findings: verdict.findings.filter((finding) => finding.code === code).length, checked, eligible };
}
