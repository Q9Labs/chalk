// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
// The backstop findings a verdict adds over its checks: witnesses that disagree, evidence no finding explains (UNEXPLAINED) and
// claims no check could read (BLIND_SPOT), and the reports that explain them.
import { createHash } from "node:crypto";
import { overlaps } from "./evidence.mjs";
import { factKind } from "./facts.mjs";
import { byKey } from "./bundle.mjs";

/** @typedef {import("./verdict.mjs").Backstop} Backstop */
/** @typedef {import("./bundle.mjs").BoundObservation} BoundObservation */
/** @typedef {import("./verdict.mjs").Disagreement} Disagreement */
/** @typedef {import("./verdict.mjs").Finding} Finding */
/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./profile.mjs").PlannedCheck} PlannedCheck */
/** @typedef {import("./verdict.mjs").Report} Report */
/** @typedef {import("./bundle.mjs").SealedBundle} SealedBundle */
/** @typedef {import("./verdict.mjs").Verdict} Verdict */

/**
 * Contradictions between witnesses of one fact on one subject, compared the way the fact's kind allows (see facts.mjs).
 * @param {SealedBundle} bundle
 * @returns {Disagreement[]}
 */
export function witnessDisagreements(bundle) {
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
export function unexplained(bundle, findings, rules) {
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
export function blindSpots(bundle, findings, rules) {
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
 * The reports this bundle holds, and the prior verdict's reports whose rows are gone, kept as they were judged.
 * @param {SealedBundle} bundle
 * @param {readonly Finding[]} findings
 * @param {Verdict | null} prior
 * @returns {Report[]}
 */
export function reportsOf(bundle, findings, prior) {
  const read = bundle.observations.filter((o) => o.fact === "report.problem").map((o) => ({ evidence: o.id, subject: o.bound, window: o.window, text: String(o.value.text ?? o.claim), explained_by: explainer(findings, o)?.id ?? null }));
  const gone = (prior?.reports ?? []).filter((report) => !holdsReportOf(bundle, report));
  return [...read, ...gone].sort(byKey((report) => `${String(report.window.from_ms).padStart(15, "0")}|${report.evidence}`));
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
export function findingId(/** @type {SealedBundle} */ bundle, /** @type {string} */ code, /** @type {string} */ subject, /** @type {string} */ at) {
  const { kind, id } = bundle.profile.declaration;
  return createHash("sha256").update(`${kind}|${id}|${code}|${subject}|${at}`).digest("hex").slice(0, 32);
}

/**
 * @param {Readonly<Observation> & { bound?: string }} o
 * @returns {Readonly<Observation>}
 */
export function stripBinding(o) {
  const { bound: _bound, ...rest } = o;
  return rest;
}

/**
 * @param {string} template
 * @param {SealedBundle} bundle
 * @param {PlannedCheck} planned
 */
export function fillQuery(template, bundle, planned) {
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

/**
 * @param {SealedBundle} bundle
 * @param {{ facts: readonly { evidence: readonly string[] }[] } | { evidence: string }} entry a finding or a report entry
 */
export const holdsReportOf = (bundle, entry) => {
  const ids = "facts" in entry ? entry.facts.flatMap((fact) => fact.evidence) : [entry.evidence];
  return bundle.observations.some((o) => o.fact === "report.problem" && ids.includes(o.id));
};
