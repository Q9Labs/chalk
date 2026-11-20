// @ts-check
/**
 * Observations, watermarks and readings: the three shapes every witness passes through.
 *
 * An observation is one witness's claim about one fact. A watermark is what a source proves about itself: how far it was read and
 * which facts its build can emit. A reading is what one requirement of a check learns from both: the fact is present, absent with
 * proof, or unknown. Zero, "" and null never stand in for missing: a count of 0 voiced packets is a present value, and a fact nobody
 * could have emitted is unknown, never absent.
 */
import { factKind } from "./facts.mjs";

/** @typedef {{ from_ms: number, to_ms: number }} Window */

/**
 * The subject an observation names, in canonical ids (never display handles). A source sets only the keys it knows.
 * @typedef {{ episode?: string, participant?: string, generation?: number, connection?: string, attempt?: string, job?: string }} Subject
 */

/**
 * @typedef {{
 *   id: string,
 *   fact: string,
 *   source: string,
 *   origin: string,
 *   subject: Readonly<Subject>,
 *   window: Readonly<Window>,
 *   claim: string,
 *   value: Readonly<Record<string, number | string | boolean>>,
 *   failure: boolean,
 *   query: string,
 * }} Observation
 *
 * - `id`: the row's stable event id (C1 envelope `event_id`, deduplicated by C3); its display handle is `ev_`.
 * - `source`: the delivery stream whose watermark proves completeness: client, api, sfu, sync, db, recorder or report.
 * - `origin`: the independence key, the authority that determined the value. Two rows copying one decision share an origin, so they
 *   count as one witness: build it with `origin.decision(id)` or `origin.measured(source)`, never from the row's own source by habit.
 * - `claim`: the canonical value compared across witnesses (see facts.mjs for how each fact kind compares).
 * - `value`: measured detail for rules and display, with units as name suffixes (`packets`, `voiced`, `rms_dbfs`).
 * - `failure`: a failed outcome (a kernel `error(code)`, a failure surface, a failed leave). Every one must be claimed by a finding.
 * - `query`: a reproducible lookup of this row in its store.
 */

/** Independence keys. A copy of a decision names the decision, so the copy and the original are one witness. */
export const origin = Object.freeze({
  /** @param {string} decisionId */
  decision: (decisionId) => `decision:${decisionId}`,
  /** @param {string} source @param {string} [instance] */
  measured: (source, instance) => (instance ? `measured:${source}:${instance}` : `measured:${source}`),
  /** @param {string} participant */
  person: (participant) => `person:${participant}`,
});

/**
 * Checks an adapter's observation at the boundary and freezes it, so every later stage trusts its shape.
 * @param {Observation} o
 * @returns {Readonly<Observation>}
 */
export function observation(o) {
  const where = `observation ${JSON.stringify(o?.id)}`;
  for (const key of /** @type {const} */ (["id", "fact", "source", "origin", "claim", "query"])) {
    if (typeof o[key] !== "string" || o[key] === "") throw new TypeError(`${where}: ${key} must be a non-empty string`);
  }
  factKind(o.fact);
  checkWindow(o.window, where);
  if (typeof o.failure !== "boolean") throw new TypeError(`${where}: failure must be true or false`);
  if (o.subject === null || typeof o.subject !== "object") throw new TypeError(`${where}: subject is required`);
  return Object.freeze({ ...o, subject: Object.freeze({ ...o.subject }), window: Object.freeze({ ...o.window }), value: Object.freeze({ ...o.value }) });
}

/**
 * What a source proves about itself for one subject, folded from C3's source watermarks and `evidence_gap` records.
 *
 * - `subject`: a seat key (`pt:<participant id>`) for a per-client source, or `*` when one stream serves the whole item (API, SFU,
 *   database). A client source is always per seat: one seat's complete client says nothing about another seat's client.
 * - `complete_to_ms`: every durably enqueued record with a time up to here was read; null when the source was not read at all.
 * - `evidence_gaps`: C3's `evidence_gap` ranges; `to_ms: null` is an unknown tail (a client vanished with no persisted high-water mark).
 * - `emits`: the facts the build behind the source is registered to emit (C1 registry, by app version and schema version). A fact
 *   the build cannot emit is unknown, never absent, so missing board data never reads as "board unused".
 * - `build`: the build that produced the source, for the reader (`client 3.1.0`).
 *
 * @typedef {{ from_ms: number, to_ms: number | null, reason: string }} EvidenceGap
 * @typedef {{ source: string, subject: string, complete_to_ms: number | null, evidence_gaps: readonly EvidenceGap[], emits: readonly string[], build: string }} Watermark
 */

/**
 * @param {Watermark} w
 * @returns {Readonly<Watermark>}
 */
export function watermark(w) {
  const where = `watermark ${w?.source}/${w?.subject}`;
  if (typeof w.source !== "string" || w.source === "" || typeof w.subject !== "string" || w.subject === "") throw new TypeError(`${where}: source and subject are required`);
  if (w.complete_to_ms !== null && !Number.isFinite(w.complete_to_ms)) throw new TypeError(`${where}: complete_to_ms must be a number or null`);
  if (!Array.isArray(w.emits) || !Array.isArray(w.evidence_gaps)) throw new TypeError(`${where}: emits and evidence_gaps are lists`);
  return Object.freeze({ ...w, emits: Object.freeze([...w.emits]), evidence_gaps: Object.freeze(w.evidence_gaps.map((gap) => Object.freeze({ ...gap }))) });
}

/**
 * Why a source does not prove a window complete for a fact. Structured, so the CLI formats times against its own anchor.
 * @typedef {{ why: "not_read", source: string, subject: string, fact: string }
 *   | { why: "not_emitted", source: string, subject: string, fact: string, build: string }
 *   | { why: "behind", source: string, subject: string, fact: string, complete_to_ms: number }
 *   | { why: "evidence_gap", source: string, subject: string, fact: string, gap: EvidenceGap }
 *   | { why: "independence", fact: string, needed: number, found: number }} Uncovered
 */

/**
 * Whether one source's watermark proves that every record about `fact` in `window` was read.
 * @param {Readonly<Watermark> | undefined} w
 * @param {{ source: string, subject: string, fact: string, window: Window }} need
 * @returns {Uncovered | null} null when covered
 */
export function uncovered(w, { source, subject, fact, window }) {
  if (w === undefined || w.complete_to_ms === null) return { why: "not_read", source, subject, fact };
  if (!w.emits.includes(fact)) return { why: "not_emitted", source, subject, fact, build: w.build };
  if (w.complete_to_ms < window.to_ms) return { why: "behind", source, subject, fact, complete_to_ms: w.complete_to_ms };
  const gap = w.evidence_gaps.find((candidate) => candidate.from_ms < window.to_ms && (candidate.to_ms === null || candidate.to_ms > window.from_ms));
  return gap ? { why: "evidence_gap", source, subject, fact, gap } : null;
}

/**
 * @typedef {{ kind: "present", observations: readonly Readonly<Observation>[], complete: boolean, origins: number, uncovered: readonly Uncovered[] }
 *   | { kind: "absent", watermarks: readonly Readonly<Watermark>[] }
 *   | { kind: "unknown", observations: readonly Readonly<Observation>[], uncovered: readonly Uncovered[] }} Reading
 *
 * - `present`: the witnesses claimed the fact. `complete` is true when every source covered the window, so no unread record can
 *   change the reading; an incomplete present reading holds only final observations (see facts.mjs).
 * - `absent`: every source covered the window, could emit the fact, and nothing claimed it. The watermarks are the proof.
 * - `unknown`: a source did not cover the window and no final observation was found. `observations` holds unfinished aggregates
 *   for display only; a rule may not cite them.
 */

/**
 * The reading of one fact, from the observations that matched its subject and window and the coverage of each source asked for.
 * @param {readonly Readonly<Observation>[]} matched
 * @param {readonly { watermark: Readonly<Watermark> | undefined, gap: Uncovered | null }[]} coverage
 * @returns {Reading}
 */
export function reading(matched, coverage) {
  const gaps = coverage.flatMap(({ gap }) => (gap ? [gap] : []));
  const origins = (/** @type {readonly { origin: string }[]} */ list) => new Set(list.map((o) => o.origin)).size;
  if (gaps.length === 0) {
    if (matched.length === 0) return { kind: "absent", watermarks: coverage.flatMap(({ watermark: w }) => (w ? [w] : [])) };
    return { kind: "present", observations: matched, complete: true, origins: origins(matched), uncovered: [] };
  }
  const final = matched.filter((o) => factKind(o.fact) !== "aggregate");
  if (final.length > 0) return { kind: "present", observations: final, complete: false, origins: origins(final), uncovered: gaps };
  return { kind: "unknown", observations: matched, uncovered: gaps };
}

/** @param {Window} a @param {Window} b */
export const overlaps = (a, b) => (a.from_ms === a.to_ms || b.from_ms === b.to_ms ? a.from_ms <= b.to_ms && b.from_ms <= a.to_ms : a.from_ms < b.to_ms && b.from_ms < a.to_ms);

/** @param {Window} w @param {string} where */
function checkWindow(w, where) {
  if (!w || !Number.isFinite(w.from_ms) || !Number.isFinite(w.to_ms) || w.from_ms > w.to_ms) throw new TypeError(`${where}: window must have finite from_ms <= to_ms`);
}
