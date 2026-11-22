// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
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
import { uncovered as uncoveredBy } from "./evidence.mjs";
import { FACTS } from "./facts.mjs";
import { validateCatalogue } from "./rules.mjs";
import { ITEM, deepFreeze } from "./profile.mjs";
import { byKey, isSealed, watermarkOf } from "./bundle.mjs";
import { blindSpots, holdsReportOf, reportsOf, unexplained, witnessDisagreements } from "./backstops.mjs";
import { runCheck } from "./run-check.mjs";

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
const KERNEL = ["facts.mjs", "evidence.mjs", "profile.mjs", "bundle.mjs", "rules.mjs", "verdict.mjs", "run-check.mjs", "backstops.mjs", "rows.mjs", "catalogue.mjs"].map((name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8")).join("\n");

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
  const text = [
    KERNEL,
    JSON.stringify(FACTS),
    ...sources,
    ...[...catalogue].sort(byKey((def) => def.code)).map((def) => JSON.stringify([def.code, def.item, def.per, def.requires, def.optional, def.healthy_absent ?? [], def.expected, def.settle_ms ?? 0, String(def.applies), String(def.decide)])),
  ].join("\n");
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
  retainPrior(bundle, prior, runs, findings, disagreement);
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
    reports: reportsOf(bundle, findings, prior),
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
 * check, the two readings disagree and the verdict says so instead of quietly dropping the earlier finding. A BLIND_SPOT is
 * recomputed only while the bundle still holds its report; once the report row is gone nothing can decide it again, so it stays.
 * @param {SealedBundle} bundle
 * @param {Verdict | null} prior
 * @param {readonly Run[]} runs
 * @param {Finding[]} findings
 * @param {Disagreement[]} disagreement
 */
function retainPrior(bundle, prior, runs, findings, disagreement) {
  if (prior === null) return;
  for (const earlier of prior.findings) {
    if (findings.some((finding) => finding.id === earlier.id) || (earlier.backstop === "BLIND_SPOT" && holdsReportOf(bundle, earlier))) continue;
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
  const gap = uncoveredBy(watermarkOf(bundle, "report", ITEM), { source: "report", subject: ITEM, fact: "report.problem", window });
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
