// @ts-check
/**
 * The verdict: three separate fields, never one precedence lattice.
 *
 * - `outcome` says what the proven findings show: broken, degraded or expected, or, with no finding, healthy or unknown.
 * - `coverage` says how much of the profile the evidence decided: complete, or partial with every gap named.
 * - `disagreement` lists witnesses that contradict each other, and earlier findings a complete re-read no longer reproduces.
 *
 * `healthy` is built in one place (`outcomeOf`) and only when there is no finding, coverage is complete over a non-empty profile and
 * nothing disagrees, all from a sealed bundle. A missing, aged, re-identified or contradicted witness therefore takes `healthy` away,
 * and a finding already proven is carried forward when its evidence is gone, so deleting evidence never erases it.
 *
 * Backstops: a failed outcome no finding claims is `UNEXPLAINED`; a problem report no earlier finding explains is `BLIND_SPOT`;
 * contradicting witnesses are `WITNESS_DISAGREEMENT` in the disagreement field. `UNCHECKED` belongs to an item with no current
 * verdict, so it lives in check.mjs.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { overlaps, reading, uncovered as uncoveredBy } from "./evidence.mjs";
import { FACTS, factDef, factKind } from "./facts.mjs";
import { validateCatalogue, validateDecision } from "./rules.mjs";
import { ITEM, deepFreeze } from "./profile.mjs";
import { byKey, isSealed, watermarkKey } from "./bundle.mjs";

/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */
/** @typedef {import("./evidence.mjs").Window} Window */
/** @typedef {import("./evidence.mjs").Reading} Reading */
/** @typedef {import("./evidence.mjs").Uncovered} Uncovered */
/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./profile.mjs").PlannedCheck} PlannedCheck */
/** @typedef {import("./profile.mjs").Requirement} Requirement */
/** @typedef {import("./profile.mjs").Decision} Decision */
/** @typedef {import("./profile.mjs").Fact} Fact */
/** @typedef {import("./profile.mjs").Hypothesis} Hypothesis */
/** @typedef {import("./bundle.mjs").SealedBundle} SealedBundle */
/** @typedef {import("./bundle.mjs").BoundObservation} BoundObservation */

/**
 * @typedef {"broken" | "degraded" | "expected" | "healthy" | "unknown"} Outcome
 * @typedef {typeof BACKSTOPS[number]} Backstop
 * @typedef {{ kind: "check", code: string, subject: string, uncovered: readonly Uncovered[], reason: string | null }
 *   | { kind: "unbound", evidence: string, fact: string, why: string }
 *   | { kind: "open" }
 *   | { kind: "empty" }} Gap
 * @typedef {{ evidence: string, source: string, origin: string, claim: string, window: Window }} Claim
 * @typedef {{ kind: "witness", fact: string, subject: string, claims: readonly Claim[], independent: boolean }
 *   | { kind: "finding", finding: string, code: string, subject: string, reason: string }} Disagreement
 * @typedef {{
 *   id: string,
 *   code: string,
 *   outcome: import("./profile.mjs").FindingOutcome | "unknown",
 *   backstop: Backstop | null,
 *   subject: string,
 *   window: Window,
 *   hop: string | null,
 *   module: string | null,
 *   reason: string | null,
 *   upstream: "witnessed" | "unknown" | null,
 *   expected: string,
 *   observed: string,
 *   facts: readonly Fact[],
 *   hypothesis: Hypothesis | null,
 *   falsify: { absence: string | null, attribution: string | null },
 *   proof: { observations: readonly Readonly<Observation>[], watermarks: readonly Readonly<Watermark>[], queries: readonly { fact: string, text: string }[], uncovered: readonly Uncovered[] },
 *   rules: string,
 *   bundle: string,
 *   retained: { from_bundle: string } | null,
 * }} Finding
 * `proof` is the finding's proof copy: the cited rows, the watermarks behind its readings and the queries that reproduce them, so the
 * finding stays readable after the store deletes the rows.
 * @typedef {{ evidence: string, subject: string, window: Window, text: string, explained_by: string | null }} Report
 * A problem report and the finding that explains it: the latest finding (other than a BLIND_SPOT) that started at or before it, or
 * null when none did, in which case the report is a BLIND_SPOT finding.
 * @typedef {{ state: "complete" | "partial", checked: number, eligible: number, by_code: Readonly<Record<string, { checked: number, eligible: number }>>, gaps: readonly Gap[] }} Coverage
 * @typedef {{
 *   v: 1,
 *   item: { kind: import("./profile.mjs").Declaration["kind"], id: string, tenant: string },
 *   window: Window,
 *   open: boolean,
 *   outcome: Outcome,
 *   coverage: Coverage,
 *   disagreement: readonly Disagreement[],
 *   findings: readonly Finding[],
 *   reports: readonly Report[],
 *   bundle: string,
 *   rules: string,
 *   asof_ms: number,
 * }} Verdict
 */

/** The findings the kernel itself raises, beyond the catalogue's checks. */
export const BACKSTOPS = /** @type {const} */ (["UNEXPLAINED", "BLIND_SPOT"]);

/**
 * The judging kernel's own source, with the row adapter and the catalogue's assembly: a change to how rows become observations, how
 * checks are built, or how readings, coverage or outcomes work changes every rules version.
 */
const KERNEL = ["facts.mjs", "evidence.mjs", "profile.mjs", "bundle.mjs", "rules.mjs", "verdict.mjs", "rows.mjs", "catalogue.mjs"].map((name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).join("\n");

/**
 * A version for a set of checks: it changes whenever a code, a requirement, a rule's source, the modules that define the rules (their
 * thresholds and helpers, which a rule's own source names but does not contain), a registry fact (its kind, witnessing events,
 * claim field or failure claims, which decide what a check reads) or the kernel changes, so a stored verdict judged by
 * other rules reads as stale and `check` judges it again. Hashing whole files is deliberately coarse: a comment edit also makes every
 * verdict stale, which costs a recheck, while a missed logic edit would serve old verdicts as current.
 * @param {readonly CheckDef[]} catalogue
 * @param {readonly string[]} sources the text of every module the catalogue's rules are defined in
 */
export function rulesVersion(catalogue, sources) {
  validateCatalogue(catalogue);
  const text = [KERNEL, JSON.stringify(FACTS), ...sources, ...[...catalogue].sort(byKey((def) => def.code)).map((def) => JSON.stringify([def.code, def.item, def.per, def.requires, def.optional, def.expected, def.settle_ms ?? 0, String(def.applies), String(def.decide)]))].join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/**
 * @param {SealedBundle} bundle
 * @param {readonly CheckDef[]} catalogue
 * @param {{ rules: string, prior?: Verdict | null }} options `prior` is the stored verdict of the same item, if any
 * @returns {Verdict}
 */
export function judge(bundle, catalogue, { rules, prior = null }) {
  if (!isSealed(bundle)) throw new TypeError("judge needs a sealed ProofBundle: openBundle(profile).seal()");
  const { profile } = bundle;
  const declaration = profile.declaration;
  if (prior !== null && (prior.item.kind !== declaration.kind || prior.item.id !== declaration.id)) throw new TypeError("the prior verdict belongs to another item");
  const defs = indexCatalogue(catalogue);
  const runs = profile.checks.map((planned) => {
    const def = defs.get(planned.code);
    if (!def) throw new TypeError(`the profile plans ${planned.code}, which the catalogue does not define`);
    return runCheck(bundle, planned, def, rules);
  });

  /** @type {Finding[]} */
  const findings = runs.flatMap((run) => (run.finding ? [run.finding] : []));
  /** @type {Disagreement[]} */
  const disagreement = witnessDisagreements(bundle);
  retainPrior(prior, runs, findings, disagreement);
  findings.push(...unexplained(bundle, findings, rules));
  findings.push(...blindSpots(bundle, findings, rules));
  findings.sort(byKey((finding) => `${String(finding.window.from_ms).padStart(15, "0")}|${finding.code}|${finding.id}`));
  const coverage = coverageOf(bundle, runs);
  return deepFreeze({
    v: 1,
    item: { kind: declaration.kind, id: declaration.id, tenant: declaration.tenant },
    window: profile.window,
    open: profile.open,
    outcome: outcomeOf(findings, coverage, disagreement),
    coverage,
    disagreement,
    findings,
    reports: reportsOf(bundle, findings),
    bundle: bundle.digest,
    rules,
    asof_ms: bundle.asof_ms,
  });
}

/**
 * @param {readonly CheckDef[]} catalogue
 * @returns {Map<string, CheckDef>}
 */
function indexCatalogue(catalogue) {
  validateCatalogue(catalogue);
  return new Map(catalogue.map((def) => [def.code, def]));
}

/** @typedef {ReturnType<typeof runCheck>} Run */

/**
 * Findings of the stored verdict that this bundle no longer reproduces stay, marked retained; when a complete re-read passes the same
 * check, the two readings disagree and the verdict says so instead of quietly dropping the earlier finding.
 * @param {Verdict | null} prior
 * @param {readonly Run[]} runs
 * @param {Finding[]} findings
 * @param {Disagreement[]} disagreement
 */
function retainPrior(prior, runs, findings, disagreement) {
  if (prior === null) return;
  for (const earlier of prior.findings) {
    if (earlier.backstop === "BLIND_SPOT" || findings.some((finding) => finding.id === earlier.id)) continue;
    findings.push({ ...earlier, retained: earlier.retained ?? { from_bundle: prior.bundle } });
    const rerun = runs.find((run) => run.planned.code === earlier.code && run.planned.subject === earlier.subject);
    if (rerun?.ready && rerun.decision.status === "pass") disagreement.push({ kind: "finding", finding: earlier.id, code: earlier.code, subject: earlier.subject, reason: "a complete re-read of the evidence passes this check" });
  }
}

/**
 * @param {SealedBundle} bundle
 * @param {readonly Run[]} runs
 * @returns {Coverage}
 */
function coverageOf(bundle, runs) {
  const { profile } = bundle;
  /** @type {Gap[]} */
  const gaps = [];
  if (profile.open) gaps.push({ kind: "open" });
  if (profile.checks.length === 0) gaps.push({ kind: "empty" });
  for (const run of runs) if (!run.ready) gaps.push({ kind: "check", code: run.planned.code, subject: run.planned.subject, uncovered: run.uncovered, reason: run.decision.status === "unknown" ? run.decision.reason : null });
  const reports = reportCoverage(bundle);
  if (reports.length > 0) gaps.push({ kind: "check", code: "BLIND_SPOT", subject: ITEM, uncovered: reports, reason: "problem reports not read completely" });
  for (const entry of bundle.unbound) gaps.push({ kind: "unbound", ...entry });

  /** @type {Record<string, { checked: number, eligible: number }>} */
  const byCode = {};
  const tally = (/** @type {string} */ code, /** @type {boolean} */ ready) => {
    const counts = (byCode[code] ??= { checked: 0, eligible: 0 });
    counts.eligible += 1;
    if (ready) counts.checked += 1;
  };
  for (const run of runs) tally(run.planned.code, run.ready);
  if (profile.declaration.kind === "episode") tally("BLIND_SPOT", reports.length === 0);
  const counts = Object.values(byCode);
  return { state: gaps.length === 0 ? "complete" : "partial", checked: counts.reduce((sum, entry) => sum + entry.checked, 0), eligible: counts.reduce((sum, entry) => sum + entry.eligible, 0), by_code: byCode, gaps };
}

/**
 * The BLIND_SPOT backstop is a check too: on an Episode, the report stream must cover the whole window before "nobody reported a
 * problem" counts, so a report lost to a gap cannot leave an Episode healthy. Attempts and jobs carry no reports.
 * @param {SealedBundle} bundle
 * @returns {Uncovered[]}
 */
function reportCoverage(bundle) {
  const { declaration, window } = bundle.profile;
  if (declaration.kind !== "episode") return [];
  const gap = uncoveredBy(bundle.watermarks.get(watermarkKey("report", ITEM)), { source: "report", subject: ITEM, fact: "report.problem", window });
  return gap ? [gap] : [];
}

/**
 * The only place `healthy` is produced.
 * @param {readonly Finding[]} findings
 * @param {Coverage} coverage
 * @param {readonly Disagreement[]} disagreement
 * @returns {Outcome}
 */
function outcomeOf(findings, coverage, disagreement) {
  for (const outcome of /** @type {const} */ (["broken", "degraded", "expected"])) if (findings.some((finding) => finding.outcome === outcome)) return outcome;
  const proven = findings.length === 0 && coverage.state === "complete" && coverage.eligible > 0 && disagreement.length === 0;
  return proven ? "healthy" : "unknown";
}

/**
 * Reads every requirement, asks the rule, and holds the rule to its evidence: a finding may cite only rows its readings can stand on,
 * and a check counts as checked only when every required reading is complete and independent enough, whatever the rule said.
 * @param {SealedBundle} bundle
 * @param {PlannedCheck} planned
 * @param {CheckDef} def
 * @param {string} rules
 */
function runCheck(bundle, planned, def, rules) {
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
  const decision = decideWith(where, def, { readings, failures, window: planned.window, declaration: bundle.profile.declaration, seat: planned.seat });

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
      observations: [...cited]
        .sort()
        .map((id) => /** @type {Readonly<Observation>} */ (citable.get(id)))
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
  /** @type {Map<string, Readonly<Observation>>} */
  const citable = new Map();
  for (const value of Object.values(readings)) if (value.kind === "present") for (const o of value.observations) citable.set(o.id, o);
  for (const o of failures) citable.set(o.id, o);
  /** @type {Set<string>} */
  const cited = new Set();
  for (const fact of facts) {
    for (const id of fact.evidence) {
      if (!citable.has(id)) throw new TypeError(`${where}: a fact cites ${id}, which is not a present, citable observation of this check`);
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
  factKind(requirement.fact);
  const itemFact = factDef(requirement.fact).per === "item";
  const onSubject = (/** @type {BoundObservation} */ o) => planned.subject === ITEM || o.bound === planned.subject || (itemFact && o.bound === ITEM);
  const matched = bundle.observations.filter((o) => o.fact === requirement.fact && requirement.from.includes(o.source) && onSubject(o) && overlaps(o.window, planned.window)).map(stripBinding);
  const declaration = bundle.profile.declaration;
  const coverage = requirement.from.flatMap((source) => {
    const wide = bundle.watermarks.get(watermarkKey(source, ITEM));
    /** @type {string[]} */
    let subjects;
    if (wide) subjects = [ITEM];
    else if (planned.subject !== ITEM) subjects = itemFact ? [ITEM] : [planned.subject];
    else subjects = declaration.kind === "episode" && declaration.seats.length > 0 ? declaration.seats.map((seat) => `pt:${seat.participant}`) : [ITEM];
    return subjects.map((subject) => {
      const w = bundle.watermarks.get(watermarkKey(source, subject));
      return { watermark: w, gap: uncoveredBy(w, { source, subject, fact: requirement.fact, window: planned.window }) };
    });
  });
  return { value: reading(matched, coverage), watermarks: coverage.flatMap(({ watermark: w }) => (w ? [w] : [])) };
}

/**
 * Contradictions between witnesses of one fact on one subject, compared the way the fact's kind allows (see facts.mjs).
 * @param {SealedBundle} bundle
 * @returns {Disagreement[]}
 */
function witnessDisagreements(bundle) {
  /** @type {Map<string, BoundObservation[]>} */
  const groups = new Map();
  for (const o of bundle.observations) {
    const key = `${o.fact}|${o.bound}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  /** @type {Disagreement[]} */
  const out = [];
  for (const [key, list] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [fact, subject] = key.split("|");
    for (const cluster of clusters(factKind(fact), list)) {
      if (new Set(cluster.map((o) => o.claim)).size < 2) continue;
      const independent = cluster.some((a) => cluster.some((b) => a.claim !== b.claim && a.origin !== b.origin));
      out.push({ kind: "witness", fact, subject, independent, claims: cluster.map((o) => ({ evidence: o.id, source: o.source, origin: o.origin, claim: o.claim, window: o.window })) });
    }
  }
  return out;
}

/**
 * @param {import("./facts.mjs").FactKind} kind
 * @param {BoundObservation[]} list
 * @returns {BoundObservation[][]}
 */
function clusters(kind, list) {
  if (kind === "event") return [];
  if (kind === "once") return [list];
  const sorted = [...list].sort((a, b) => a.window.from_ms - b.window.from_ms || a.window.to_ms - b.window.to_ms || (a.id < b.id ? -1 : 1));
  if (kind === "aggregate") {
    const exact = new Map();
    for (const o of sorted) exact.set(`${o.window.from_ms}-${o.window.to_ms}`, [...(exact.get(`${o.window.from_ms}-${o.window.to_ms}`) ?? []), o]);
    return [...exact.values()];
  }
  /** @type {BoundObservation[][]} */
  const out = [];
  for (const o of sorted) {
    const last = out.at(-1);
    if (last && last.some((other) => overlaps(other.window, o.window))) last.push(o);
    else out.push([o]);
  }
  return out;
}

/**
 * Failed outcomes that no finding cites: the catalogue has no rule for them yet.
 * @param {SealedBundle} bundle
 * @param {readonly Finding[]} findings
 * @param {string} rules
 * @returns {Finding[]}
 */
function unexplained(bundle, findings, rules) {
  const claimed = new Set(findings.flatMap((finding) => finding.proof.observations.map((o) => o.id)));
  return bundle.observations
    .filter((o) => o.failure && !claimed.has(o.id))
    .map((o) =>
      backstopFinding(bundle, rules, o, {
        backstop: "UNEXPLAINED",
        outcome: "broken",
        expected: "every failed outcome is claimed by a finding of some check",
        falsify: { absence: null, attribution: "a check whose finding claims this failure" },
      }),
    );
}

/**
 * Problem reports that no finding starting at or before the report explains: the catalogue missed what the person lived.
 * @param {SealedBundle} bundle
 * @param {readonly Finding[]} findings
 * @param {string} rules
 * @returns {Finding[]}
 */
function blindSpots(bundle, findings, rules) {
  return bundle.observations
    .filter((o) => o.fact === "report.problem" && explainer(findings, o) === null)
    .map((o) =>
      backstopFinding(bundle, rules, o, {
        backstop: "BLIND_SPOT",
        outcome: "unknown",
        expected: "a problem report follows a finding that explains it",
        falsify: { absence: null, attribution: "a finding before the report that explains what the person saw" },
      }),
    );
}

/**
 * The finding that explains a report: the latest one, other than a BLIND_SPOT, that started at or before it.
 * @param {readonly Finding[]} findings
 * @param {Readonly<Observation>} report
 */
function explainer(findings, report) {
  const before = findings.filter((finding) => finding.backstop !== "BLIND_SPOT" && finding.window.from_ms <= report.window.from_ms);
  before.sort(byKey((finding) => `${String(finding.window.from_ms).padStart(15, "0")}|${finding.code}|${finding.id}`));
  return before.at(-1) ?? null;
}

/**
 * @param {SealedBundle} bundle
 * @param {readonly Finding[]} findings
 * @returns {Report[]}
 */
function reportsOf(bundle, findings) {
  return bundle.observations
    .filter((o) => o.fact === "report.problem")
    .map((o) => ({ evidence: o.id, subject: o.bound, window: o.window, text: String(o.value.text ?? o.claim), explained_by: explainer(findings, o)?.id ?? null }))
    .sort(byKey((report) => `${String(report.window.from_ms).padStart(15, "0")}|${report.evidence}`));
}

/**
 * @param {SealedBundle} bundle
 * @param {string} rules
 * @param {BoundObservation} o
 * @param {{ backstop: Backstop, outcome: "broken" | "unknown", expected: string, falsify: Finding["falsify"] }} kind
 * @returns {Finding}
 */
function backstopFinding(bundle, rules, o, { backstop, outcome, expected, falsify }) {
  const text = o.fact === "report.problem" ? `problem report: ${o.value.text ?? o.claim}` : `${o.fact} ${o.claim}`;
  return {
    id: findingId(bundle, backstop, o.bound, o.id),
    code: backstop,
    outcome,
    backstop,
    subject: o.bound,
    window: o.window,
    hop: null,
    module: "unknown",
    reason: null,
    upstream: null,
    expected,
    observed: text,
    facts: [{ text, evidence: [o.id], window: o.window, absent: null }],
    hypothesis: null,
    falsify,
    proof: { observations: [stripBinding(o)], watermarks: [], queries: [], uncovered: [] },
    rules,
    bundle: bundle.digest,
    retained: null,
  };
}

/** A finding id is stable across re-checks of the same evidence: item, code, subject and where it starts. */
function findingId(/** @type {SealedBundle} */ bundle, /** @type {string} */ code, /** @type {string} */ subject, /** @type {string} */ at) {
  const { kind, id } = bundle.profile.declaration;
  return createHash("sha256").update(`${kind}|${id}|${code}|${subject}|${at}`).digest("hex").slice(0, 32);
}

/**
 * @param {Readonly<Observation> & { bound?: string }} o
 * @returns {Readonly<Observation>}
 */
function stripBinding(o) {
  const { bound: _bound, ...rest } = o;
  return rest;
}

/**
 * @param {string} template
 * @param {SealedBundle} bundle
 * @param {PlannedCheck} planned
 */
function fillQuery(template, bundle, planned) {
  const declaration = bundle.profile.declaration;
  /** @type {Record<string, string>} */
  const values = {
    episode: declaration.kind === "episode" ? declaration.id : declaration.kind === "job" ? declaration.episode : "",
    participant: planned.seat?.participant ?? "",
    attempt: declaration.kind === "attempt" ? declaration.id : "",
    job: declaration.kind === "job" ? declaration.id : "",
    space: declaration.kind === "space" ? declaration.id : "",
    tenant: declaration.tenant ?? "",
    environment: declaration.kind === "platform" ? declaration.id : "",
    day: "day" in declaration ? declaration.day : "",
    from: new Date(planned.window.from_ms).toISOString(),
    to: new Date(planned.window.to_ms).toISOString(),
  };
  return template.replace(/\{(episode|participant|attempt|job|space|tenant|environment|day|from|to)\}/gu, (_, name) => values[name]);
}
