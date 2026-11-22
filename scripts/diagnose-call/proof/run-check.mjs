// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
// Runs one planned check over a sealed bundle: reads each required fact, decides through the check's rule, and fails closed when
// a reading is missing or uncovered.
import { overlaps, perSeat, reading, uncovered as uncoveredBy } from "./evidence.mjs";
import { factDef, factKind } from "./facts.mjs";
import { validateDecision } from "./rules.mjs";
import { ITEM, seatKey, sessionKey } from "./profile.mjs";
import { byKey, watermarkKey, watermarkOf } from "./bundle.mjs";
import { findingId, stripBinding, fillQuery } from "./backstops.mjs";

/** @typedef {import("./bundle.mjs").BoundObservation} BoundObservation */
/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./profile.mjs").Decision} Decision */
/** @typedef {import("./profile.mjs").Fact} Fact */
/** @typedef {import("./verdict.mjs").Finding} Finding */
/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./profile.mjs").PlannedCheck} PlannedCheck */
/** @typedef {import("./evidence.mjs").Reading} Reading */
/** @typedef {import("./profile.mjs").Requirement} Requirement */
/** @typedef {import("./bundle.mjs").SealedBundle} SealedBundle */
/** @typedef {import("./evidence.mjs").Uncovered} Uncovered */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */
/** @typedef {import("./evidence.mjs").Window} Window */

/**
 * Reads every requirement, asks the rule, and holds the rule to its evidence: a finding may cite only rows its readings can stand on,
 * and a check counts as checked only when every required reading is complete and independent enough, whatever the rule said.
 * @param {SealedBundle} bundle
 * @param {PlannedCheck} planned
 * @param {CheckDef} def
 * @param {string} rules
 */
export function runCheck(bundle, planned, def, rules) {
  const where = `check ${planned.key}`;
  /** @type {Record<string, Reading>} */
  const readings = {};
  /** @type {Map<string, Readonly<Watermark>>} */
  const used = new Map();
  for (const requirement of [...def.requires, ...def.optional]) {
    if (requirement.fact in readings) throw new TypeError(`${where}: requires ${requirement.fact} twice`);
    const { value, watermarks } = readFact(bundle, planned, requirement);
    readings[requirement.fact] = value;
    if (def.requires.includes(requirement)) for (const w of watermarks) used.set(watermarkKey(w.source, w.subject), w);
  }
  const failures = bundle.observations.filter((o) => o.failure && (planned.subject === ITEM || o.bound === planned.subject));
  const decision = failClosed(def, readings, decideWith(where, def, { readings, failures, window: planned.window, declaration: bundle.profile.declaration, seat: planned.seat }));

  const uncovered = uncoveredOf(def.requires, readings);
  const ready = uncovered.length === 0 && decision.status !== "unknown";
  if (decision.status !== "finding") return { planned, decision, ready, uncovered, finding: null };

  const { citable, cited } = citations(where, decision.facts, readings, failures, planned.window);
  /** @type {Finding} */
  const finding = {
    id: findingId(bundle, def.code, planned.subject, String(decision.window.from_ms)),
    code: def.code,
    outcome: decision.outcome,
    backstop: null,
    subject: planned.subject,
    window: decision.window,
    hop: decision.hop,
    module: decision.module,
    reason: decision.reason,
    upstream: decision.upstream,
    expected: def.expected,
    observed: decision.observed,
    facts: decision.facts,
    hypothesis: decision.hypothesis,
    falsify: decision.falsify,
    proof: {
      observations: citable
        .filter((o) => cited.has(o.id))
        .sort(byKey((o) => `${o.id}|${o.fact}`))
        .map(stripBinding),
      watermarks: [...used.keys()].sort().map((key) => /** @type {Readonly<Watermark>} */ (used.get(key))),
      queries: def.requires.map((requirement) => ({ fact: requirement.fact, text: fillQuery(requirement.query, bundle, planned) })),
      uncovered,
    },
    rules,
    bundle: bundle.digest,
    retained: null,
  };
  return { planned, decision, ready, uncovered, finding };
}

/**
 * Runs a rule and holds its answer to the decision shape. A rule that throws (a misspelt fact name reads as undefined) fails with the
 * check's key in front of its own message.
 * @param {string} where
 * @param {CheckDef} def
 * @param {import("./profile.mjs").DecideInput} input
 * @returns {Decision}
 */
function decideWith(where, def, input) {
  let decision;
  try {
    decision = def.decide(input);
  } catch (error) {
    throw new TypeError(`${where}: decide threw: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  validateDecision(where, decision);
  return decision;
}

/**
 * A pass stands only on its required witnesses: each must be present, or proven absent where the rule names that absence as the
 * healthy claim (`healthy_absent`). Anything else turns the pass into unknown, whatever the rule said, so a rule that forgets to look
 * at a witness, or reads a missing one as fine, can never make an item healthy.
 * @param {CheckDef} def
 * @param {Record<string, Reading>} readings
 * @param {Decision} decision
 * @returns {Decision}
 */
function failClosed(def, readings, decision) {
  if (decision.status !== "pass") return decision;
  const healthyAbsent = def.healthy_absent ?? [];
  const missing = def.requires.flatMap(({ fact }) => {
    const { kind } = readings[fact];
    return kind === "present" || (kind === "absent" && healthyAbsent.includes(fact)) ? [] : [`${fact} is ${kind}`];
  });
  return missing.length === 0 ? decision : { status: "unknown", reason: `a pass needs every required witness, but ${missing.join(" and ")}` };
}

/**
 * What keeps a check from counting as checked: every gap its required readings carry, and any reading with fewer independent
 * origins than the requirement asks for.
 * @param {readonly Requirement[]} requires
 * @param {Record<string, Reading>} readings
 * @returns {Uncovered[]}
 */
function uncoveredOf(requires, readings) {
  /** @type {Uncovered[]} */
  const uncovered = [];
  for (const requirement of requires) {
    const value = readings[requirement.fact];
    if (value.kind !== "absent") uncovered.push(...value.uncovered);
    const needed = requirement.independent ?? 1;
    if (value.kind === "present" && value.origins < needed) uncovered.push({ why: "independence", fact: requirement.fact, needed, found: value.origins });
  }
  return uncovered;
}

/**
 * Holds a finding's facts to the check's evidence: each cited row must be present in a reading or be a failure on the subject, and each
 * claimed absence must be proven by its reading.
 * @param {string} where
 * @param {readonly Fact[]} facts
 * @param {Record<string, Reading>} readings
 * @param {readonly Readonly<Observation>[]} failures
 * @param {Window} read the window the readings cover
 */
function citations(where, facts, readings, failures, read) {
  if (facts.length === 0) throw new TypeError(`${where}: a finding needs at least one fact`);
  /** @type {Map<string, Readonly<Observation>>} keyed by event id and fact, since one row may witness several facts */
  const byObservation = new Map();
  for (const value of Object.values(readings)) if (value.kind === "present") for (const o of value.observations) byObservation.set(`${o.id}|${o.fact}`, o);
  for (const o of failures) byObservation.set(`${o.id}|${o.fact}`, o);
  const citable = [...byObservation.values()];
  const ids = new Set(citable.map((o) => o.id));
  /** @type {Set<string>} */
  const cited = new Set();
  for (const fact of facts) {
    for (const id of fact.evidence) {
      if (!ids.has(id)) throw new TypeError(`${where}: a fact cites ${id}, which is not a present, citable observation of this check`);
      cited.add(id);
    }
    if (fact.absent !== null && !provenAbsent(readings[fact.absent], fact.window, read)) throw new TypeError(`${where}: a fact claims ${fact.absent} is absent, but its reading does not prove it`);
    if (fact.absent === null && fact.evidence.length === 0) throw new TypeError(`${where}: the fact "${fact.text}" cites no evidence and claims no proven absence`);
  }
  return { citable, cited };
}

/**
 * An absence is proven when the whole reading is absent, or when the reading is complete and nothing in it touches the fact's window.
 * Either way the fact's window must lie inside the window the check read, because a reading says nothing about time it never covered.
 * @param {Reading | undefined} value
 * @param {Window | null} window
 * @param {Window} read
 */
function provenAbsent(value, window, read) {
  if (value === undefined) return false;
  if (window !== null && (window.from_ms < read.from_ms || window.to_ms > read.to_ms)) return false;
  if (value.kind === "absent") return true;
  return value.kind === "present" && value.complete && window !== null && !value.observations.some((o) => overlaps(o.window, window));
}

/**
 * The reading of one requirement: the observations of its fact from its sources, on the check's subject and inside its window, and
 * the coverage of each source. An item-wide check on an Episode needs every seat's copy of a per-seat source.
 * @param {SealedBundle} bundle
 * @param {PlannedCheck} planned
 * @param {Requirement} requirement
 */
function readFact(bundle, planned, requirement) {
  const immutable = factKind(requirement.fact) === "once";
  const itemFact = factDef(requirement.fact).per === "item";
  const onSubject = (/** @type {BoundObservation} */ o) => planned.subject === ITEM || o.bound === planned.subject || (itemFact && o.bound === ITEM);
  const matched = bundle.observations.filter((o) => o.fact === requirement.fact && requirement.from.includes(o.source) && onSubject(o) && overlaps(o.window, planned.window)).map(stripBinding);
  const coverage = requirement.from.flatMap((source) => {
    const subjects = coverageSubjects(bundle, planned, source, itemFact);
    return subjects.map((subject) => {
      const w = watermarkOf(bundle, source, subject);
      const certified = immutable && matched.some((o) => o.source === source && o.id === w?.certified_once?.[requirement.fact]);
      return { watermark: w, gap: certified ? null : uncoveredBy(w, { source, subject, fact: requirement.fact, window: planned.window }) };
    });
  });
  return { value: reading(matched, coverage), watermarks: coverage.flatMap(({ watermark: w }) => (w ? [w] : [])) };
}

/**
 * The subjects whose watermarks of one source must cover a reading: the whole item when the source is one stream for it, the seat
 * of a per-seat check, every seat for an item-wide check on an Episode, and the client session of an attempt, which has no seat yet.
 * @param {SealedBundle} bundle
 * @param {PlannedCheck} planned
 * @param {string} source
 * @param {boolean} itemFact
 * @returns {string[]}
 */
function coverageSubjects(bundle, planned, source, itemFact) {
  const declaration = bundle.profile.declaration;
  if (watermarkOf(bundle, source, ITEM)) return [ITEM];
  if (planned.subject !== ITEM) return itemFact ? [ITEM] : [planned.subject];
  if (declaration.kind === "attempt" && perSeat(source)) return [sessionKey(declaration.id)];
  return declaration.kind === "episode" && declaration.seats.length > 0 ? declaration.seats.map((seat) => seatKey(seat.participant)) : [ITEM];
}
