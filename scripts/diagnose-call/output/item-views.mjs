// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
// The views of one item: the item with its findings, disagreements and reports, and the evidence behind one finding.
import { profileFor } from "../proof/profile.mjs";
import { standing } from "../proof/check.mjs";
import { isoMinute, localAnchor, ref, span, uncoveredText } from "./format.mjs";
import { page } from "./page.mjs";
import { coverageOf, dayScope, finish, itemClock, itemRef, pad, partyOf, personRef, primaryEvidence, short } from "./views.mjs";

/** @typedef {import("./views.mjs").Anchor} Anchor */
/** @typedef {import("./views.mjs").At} At */
/** @typedef {import("../proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../proof/verdict.mjs").Finding} Finding */
/** @typedef {import("./views.mjs").Head} Head */
/** @typedef {import("../proof/check.mjs").Item} Item */
/** @typedef {import("./views.mjs").Keyed} Keyed */
/** @typedef {import("./format.mjs").Party} Party */
/** @typedef {import("../proof/check.mjs").Status} Status */
/** @typedef {import("./views.mjs").Tenant} Tenant */
/** @typedef {import("../proof/verdict.mjs").Verdict} Verdict */
/** @typedef {import("../proof/verdict.mjs").Gap} VerdictGap */
/** @typedef {import("./views.mjs").Via} Via */
/** @typedef {import("./views.mjs").View} View */
/** @typedef {import("./views.mjs").ViewContext} ViewContext */

/**
 * Gaps of one verdict, grouped by check and reason so a reason shared by every seat reads once. Never paged.
 * @param {Verdict} verdict
 * @param {Declaration} declaration
 * @param {(ms: number) => string} at
 */
function verdictGaps(verdict, declaration, at) {
  /** @type {object[]} */
  const out = [];
  /** @type {Map<string, { code: string, why: string, parties: Party[] }>} */
  const groups = new Map();
  for (const gap of /** @type {readonly VerdictGap[]} */ (verdict.coverage.gaps)) {
    if (gap.kind === "open") out.push({ t: "gap", code: "open", why: `${declaration.kind === "episode" ? "the Episode" : `the ${declaration.kind}`} has not ended, so what it has not done yet is unknown` });
    else if (gap.kind === "empty") out.push({ t: "gap", code: "empty", why: "no check applies to this item, so nothing proves it healthy" });
    else if (gap.kind === "unbound") out.push({ t: "gap", code: "unbound", ev: ref("event", gap.evidence), why: `${gap.fact} ${gap.why}` });
    else {
      const why = gap.uncovered.length > 0 ? [...new Set(gap.uncovered.map((entry) => uncoveredText(entry, at)))].join("; ") : (gap.reason ?? "undecided");
      const key = `${gap.code}|${why}`;
      const group = groups.get(key) ?? { code: gap.code, why, parties: [] };
      group.parties.push(partyOf(declaration, gap.subject));
      groups.set(key, group);
    }
  }
  for (const group of [...groups.values()].sort((a, b) => (a.code + a.why < b.code + b.why ? -1 : 1))) {
    const eligible = verdict.coverage.by_code[group.code]?.eligible ?? 0;
    const seats = group.parties.filter((party) => party !== "all");
    const all = seats.length > 1 && seats.length === eligible;
    out.push({ t: "gap", code: group.code, parties: all ? [] : group.parties, all: all ? seats.length : null, why: group.why });
  }
  return out;
}

/**
 * One item in depth: an Episode, attempt or job with relative times, or a Space, Tenant or platform day with UTC clock times.
 * @param {{ item: Item, status: Status, tenant: Tenant, ctx: ViewContext, via?: Via | null }} input
 * @returns {View}
 */
export function itemView({ item, status, tenant, ctx, via = null }) {
  const { outcome, verdict } = standing(status);
  const declaration = item.declaration;
  const at = itemClock(declaration);
  const eligible = verdict?.coverage.eligible ?? profileFor(declaration, ctx.catalogue, ctx.asof_ms).checks.length;
  /** @type {Head} */
  const head = {
    view: item.kind,
    scope: dayScope(declaration) ?? { item: itemRef(item), tenant: tenant.name },
    outcome,
    coverage: coverageOf(verdict, status),
    checked: verdict?.coverage.checked ?? 0,
    eligible,
    asof: isoMinute(verdict?.asof_ms ?? ctx.asof_ms),
    rules: verdict?.rules ?? ctx.rules,
    stale: status.state === "stale" ? status.why : null,
  };
  const records = verdict === null ? [] : [...findingRecords(verdict, declaration, at), ...disagreementRecords(verdict, declaration, at), ...reportRecords(verdict, declaration, at)];
  records.sort((a, b) => (a.key < b.key ? -1 : 1));
  const paged = page(records, `${item.kind}:${item.id}`, ctx.paging, ctx.measure);

  const gaps = verdict ? verdictGaps(verdict, declaration, at) : [];
  if (status.state === "stale") gaps.unshift({ t: "gap", code: "stale", why: STALE_WHY[status.why](verdict?.rules ?? "", ctx.rules) });
  if (status.state === "unchecked") gaps.unshift({ t: "gap", code: "unchecked", why: "no verdict yet" });
  const next = itemNext(item, status, verdict, paged.page.cursor);
  return finish({ view: item.kind, head, anchor: itemAnchor(declaration, tenant), via, records: paged.records, gaps, page: paged.page, next });
}

/** @type {Record<"declaration" | "evidence" | "rules", (was: string, now: string) => string>} */
const STALE_WHY = {
  declaration: () => "the item changed after asof (seats, features or its end), so the checks it now needs are unchecked",
  evidence: () => "evidence changed after asof, so newer rows are unchecked",
  rules: (was, now) => `rules changed from ${was} to ${now}`,
};

/**
 * @param {Item["declaration"]} declaration
 * @param {Tenant} tenant
 * @returns {Anchor}
 */
function itemAnchor(declaration, tenant) {
  const anchorMs = declaration.window.from_ms;
  /** @type {Anchor} */
  const anchor = { utc: isoMinute(anchorMs), local: localAnchor(anchorMs, tenant.tz), tz: tenant.tz };
  if (declaration.kind === "episode") {
    anchor.dur = declaration.window.to_ms === null ? "open" : `${Math.round((declaration.window.to_ms - anchorMs) / 60_000)}m`;
    anchor.seats = declaration.seats.length;
  }
  if (declaration.kind === "job") anchor.episode = ref("episode", declaration.episode);
  return anchor;
}

/**
 * @param {Verdict} verdict
 * @param {Item["declaration"]} declaration
 * @param {At} at
 * @returns {Keyed[]}
 */
function findingRecords(verdict, declaration, at) {
  return verdict.findings.map((finding) => {
    const primary = primaryEvidence(finding);
    const sameWindow = (/** @type {{ from_ms: number, to_ms: number }} */ window) => window.from_ms === finding.window.from_ms && window.to_ms === finding.window.to_ms;
    return {
      key: `1|${pad(finding.window.from_ms)}|${short(finding.id)}`,
      t: "finding",
      f: ref("finding", finding.id),
      outcome: finding.outcome,
      code: finding.code,
      party: partyOf(declaration, finding.subject),
      when: span(finding.window, at),
      hop: finding.hop,
      module: finding.module,
      upstream: finding.upstream,
      reason: finding.reason,
      ev: primary === null ? null : ref("event", primary),
      retained: finding.retained !== null,
      // An expected finding (a time-limit end) explains rather than accuses, so its facts wait for `evidence`.
      facts: (finding.outcome === "expected" ? [] : finding.facts).map((fact) => ({
        text: fact.text,
        when: fact.window === null || sameWindow(fact.window) ? null : span(fact.window, at),
        ev: fact.evidence.map((id) => ref("event", id)),
        absent: fact.absent !== null,
      })),
      hypothesis: finding.hypothesis,
    };
  });
}

/**
 * @param {Verdict} verdict
 * @param {Item["declaration"]} declaration
 * @param {At} at
 * @returns {Keyed[]}
 */
function disagreementRecords(verdict, declaration, at) {
  return verdict.disagreement.map((entry) => {
    if (entry.kind === "finding") return { key: `2|${short(entry.finding)}`, t: "disagree", code: "WITNESS_DISAGREEMENT", f: ref("finding", entry.finding), about: entry.code, party: partyOf(declaration, entry.subject), why: entry.reason };
    const from = Math.min(...entry.claims.map((claim) => claim.window.from_ms));
    const to = Math.max(...entry.claims.map((claim) => claim.window.to_ms));
    return {
      key: `2|${pad(from)}|${entry.fact}|${short(entry.subject)}`,
      t: "disagree",
      code: "WITNESS_DISAGREEMENT",
      about: entry.fact,
      party: partyOf(declaration, entry.subject),
      when: span({ from_ms: from, to_ms: to }, at),
      claims: entry.claims.map((claim) => ({ source: claim.source, claim: claim.claim, ev: ref("event", claim.evidence) })),
      independent: entry.independent,
    };
  });
}

/**
 * @param {Verdict} verdict
 * @param {Item["declaration"]} declaration
 * @param {At} at
 * @returns {Keyed[]}
 */
function reportRecords(verdict, declaration, at) {
  return verdict.reports.map((report) => ({
    key: `3|${pad(report.window.from_ms)}|${short(report.evidence)}`,
    t: "report",
    ev: ref("event", report.evidence),
    party: partyOf(declaration, report.subject),
    when: at(report.window.from_ms),
    text: report.text,
    explained_by: report.explained_by === null ? null : ref("finding", report.explained_by),
  }));
}

/**
 * Drill-downs: recheck what is not current, then the worst finding's evidence and its Participant's history, then the next page.
 * @param {Item} item
 * @param {Status} status
 * @param {Verdict | null} verdict
 * @param {string | null} cursor
 */
function itemNext(item, status, verdict, cursor) {
  const next = [];
  const handle = itemRef(item);
  // `check` takes a handle or a tenant scope, and the platform has neither, so its day is rechecked by a platform sweep.
  if (status.state !== "current" && item.kind !== "platform") next.push(["check", handle]);
  const worst = (verdict?.findings ?? []).find((finding) => finding.outcome !== "expected");
  if (worst) {
    next.push(["evidence", ref("finding", worst.id)]);
    const person = personRef(item.declaration, worst.subject);
    if (person) next.push(["participant", person, "--since", "30d"]);
  }
  if (cursor) next.push([item.kind, handle, "--cursor", cursor]);
  return next;
}

/**
 * Proof sufficiency for one finding: what was expected, what was observed, the watermarks behind each reading, the queries that
 * reproduce it, and what would falsify the absence or the attribution. Never paged: it is the drill-down.
 * @param {{ item: Item, status: Status, finding: Finding, tenant: Tenant, ctx: ViewContext, via?: Via | null }} input
 * @returns {View}
 */
export function evidenceView({ item, status, finding, tenant, ctx, via = null }) {
  const { verdict } = standing(status);
  if (verdict === null) throw new TypeError("evidence needs a stored verdict");
  const declaration = item.declaration;
  const anchorMs = declaration.window.from_ms;
  const at = itemClock(declaration);
  const complete = finding.proof.uncovered.length === 0;
  /** @type {Head} */
  const head = {
    view: "evidence",
    scope: { finding: ref("finding", finding.id), code: finding.code, party: partyOf(declaration, finding.subject), item: itemRef(item) },
    outcome: finding.outcome,
    coverage: { state: complete ? "complete" : "partial", missing: [...new Set(finding.proof.uncovered.map((entry) => ("source" in entry ? entry.source : "independence")))].sort() },
    checked: complete ? 1 : 0,
    eligible: 1,
    asof: isoMinute(verdict.asof_ms),
    rules: finding.rules,
    stale: status.state === "stale" ? status.why : null,
  };
  /** @type {object[]} */
  const records = [
    { t: "expected", text: finding.expected },
    { t: "observed", text: finding.observed, when: span(finding.window, at) },
    ...finding.facts.map((fact) => ({ t: "fact", text: fact.text, when: fact.window === null ? null : span(fact.window, at), ev: fact.evidence.map((id) => ref("event", id)), absent: fact.absent })),
    ...(finding.hypothesis ? [{ t: "hypothesis", text: finding.hypothesis.text, falsified_by: finding.hypothesis.falsified_by }] : [{ t: "hypothesis", text: null, falsified_by: null }]),
    ...finding.proof.observations.map((o) => ({ t: "witness", ev: ref("event", o.id), fact: o.fact, source: o.source, origin: o.origin, claim: o.claim, when: span(o.window, at), value: o.value, row: o.query })),
    ...finding.proof.watermarks.map((w) => ({ t: "watermark", source: w.source, party: partyOf(declaration, w.subject), complete_to: w.complete_to_ms === null ? null : at(w.complete_to_ms), gaps: w.evidence_gaps.length, build: w.build })),
    ...finding.proof.queries.map((query) => ({ t: "query", fact: query.fact, text: query.text })),
    { t: "falsify", absence: finding.falsify.absence, attribution: finding.falsify.attribution },
    ...(finding.retained ? [{ t: "retained", from_bundle: finding.retained.from_bundle.slice(0, 8) }] : []),
  ];
  const independent = new Set(finding.proof.observations.map((o) => o.origin)).size;
  records.push({ t: "independence", witnesses: finding.proof.observations.length, origins: independent });
  const gaps = finding.proof.uncovered.map((entry) => ({ t: "gap", code: finding.code, parties: [], all: null, why: uncoveredText(entry, at) }));
  const next = [[item.kind, itemRef(item)]];
  return finish({ view: "evidence", head, anchor: { utc: isoMinute(anchorMs), local: localAnchor(anchorMs, tenant.tz), tz: tenant.tz }, via, records, gaps, page: null, next });
}
