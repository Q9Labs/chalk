// @ts-check
/**
 * The row adapter: telemetry rows (registry envelope plus event fields, as Axiom returns them) to the kernel's observations, and the
 * one way a symptom's fixture is judged. The registry says which events witness which fact (an area file's `facts`), so this file
 * holds no per-symptom mapping: a slice that declares a fact and its events gets its rows read here.
 *
 * A row becomes one observation per fact whose events list it. A row that can't be placed is dropped and returned with the reason,
 * never guessed: no `event_id` means it can't be cited, and no `est_server_ms` means its time is unknown, so the subject it would
 * have witnessed stays unchecked.
 */
import { FACTS, SOURCE_TABLE } from "./facts.mjs";
import { observation, origin } from "./evidence.mjs";
import { openBundle } from "./bundle.mjs";
import { ITEM, profileFor, seatKey } from "./profile.mjs";
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
const NOT_VALUES = new Set([...SUBJECT_FIELDS.map(([field]) => field), "event", "event_id", "est_server_ms", "clock_err_ms", "clock_state", "duration_ms", "decision_id"]);

/** @type {ReadonlyMap<string, readonly { fact: string, source: string, claim: string, failure_claims: readonly string[] }[]>} */
const BY_EVENT = (() => {
  /** @type {Map<string, { fact: string, source: string, claim: string, failure_claims: readonly string[] }[]>} */
  const map = new Map();
  for (const [fact, def] of Object.entries(FACTS)) {
    for (const event of def.events) map.set(event.event, [...(map.get(event.event) ?? []), { fact, source: event.source, claim: event.claim, failure_claims: event.failure_claims ?? [] }]);
  }
  return map;
})();

/** @param {string} eventId */
export const rowQuery = (eventId) => `axiom chalk-logs | where event_id == '${eventId}'`;

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
    const witnessed = BY_EVENT.get(String(row.event));
    if (!witnessed) return;
    if (typeof row.event_id !== "string" || row.event_id === "") return void dropped.push({ index, event: row.event, why: "no event_id, so it can't be cited" });
    if (typeof row.est_server_ms !== "number") return void dropped.push({ index, event: row.event, why: "no est_server_ms, so its time is unknown" });
    const err = typeof row.clock_err_ms === "number" ? row.clock_err_ms : 0;
    const window = typeof row.duration_ms === "number" ? { from_ms: row.est_server_ms, to_ms: row.est_server_ms + row.duration_ms } : { from_ms: row.est_server_ms - err, to_ms: row.est_server_ms + err };
    /** @type {Record<string, string | number>} */
    const subject = {};
    for (const [field, key] of SUBJECT_FIELDS) if (typeof row[field] === "string" || typeof row[field] === "number") subject[key] = /** @type {string | number} */ (row[field]);
    /** @type {Record<string, string | number | boolean>} */
    const value = {};
    for (const [name, field] of Object.entries(row)) if (!NOT_VALUES.has(name) && (typeof field === "string" || typeof field === "number" || typeof field === "boolean")) value[name] = field;
    for (const { fact, source, claim, failure_claims } of witnessed) {
      const claimed = row[claim];
      if (claimed === undefined || claimed === null) {
        dropped.push({ index, event: row.event, why: `no ${claim}, the field ${fact} compares` });
        continue;
      }
      observations.push(
        observation({
          id: row.event_id,
          fact,
          source,
          origin: typeof row.decision_id === "string" ? origin.decision(row.decision_id) : origin.measured(source, typeof row.client_session_id === "string" ? row.client_session_id : undefined),
          subject,
          window,
          claim: String(claimed),
          value,
          failure: failure_claims.includes(String(claimed)),
          query: rowQuery(row.event_id),
        }),
      );
    }
  });
  return { observations, dropped };
}

/**
 * The watermarks a fixture stands for when it gives none: every source the checks read is complete to `asof_ms` with no gap and
 * emits every fact the registry lets it emit, one per seat for a per-seat source.
 * @param {Declaration} declaration
 * @param {readonly CheckDef[]} catalogue
 * @param {number} asof_ms
 * @returns {Watermark[]}
 */
export function completeWatermarks(declaration, catalogue, asof_ms) {
  const sources = new Set(catalogue.flatMap((def) => [...def.requires, ...def.optional].flatMap((requirement) => requirement.from)));
  const perSeat = new Set(SOURCE_TABLE.filter((entry) => entry.per_seat).map((entry) => entry.source));
  const seats = declaration.kind === "episode" ? declaration.seats.map((seat) => seatKey(seat.participant)) : [];
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
