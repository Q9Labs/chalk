// @ts-check
/**
 * Views: the one model both output forms render. Text (text.mjs) and `--json` (json.mjs) are two encodings of the same view, so
 * they cannot drift apart in content. A view has a head (line 1), an anchor (line 2), an optional `via` (how a lookup resolved),
 * records (paged), gaps (never paged) and `next` commands.
 */
import { profileFor } from "../proof/profile.mjs";
import { standing } from "../proof/check.mjs";
import { area, finalizeHandles, isoMinute, localAnchor, localMidnight, localWhen, ref, relative, span, uncoveredText } from "./format.mjs";
import { page } from "./page.mjs";

/** @typedef {import("./format.mjs").Ref} Ref */
/** @typedef {import("./format.mjs").Party} Party */
/** @typedef {import("./page.mjs").PageOptions} PageOptions */
/** @typedef {import("./page.mjs").Page} Page */
/** @typedef {import("../proof/check.mjs").Item} Item */
/** @typedef {import("../proof/check.mjs").Status} Status */
/** @typedef {import("../proof/verdict.mjs").Verdict} Verdict */
/** @typedef {import("../proof/verdict.mjs").Finding} Finding */
/** @typedef {import("../proof/verdict.mjs").Outcome} Outcome */
/** @typedef {import("../proof/verdict.mjs").Gap} VerdictGap */
/** @typedef {import("../proof/profile.mjs").CheckDef} CheckDef */
/** @typedef {import("../proof/profile.mjs").Declaration} Declaration */

/**
 * @typedef {{ asof_ms: number, rules: string, catalogue: readonly CheckDef[], paging: PageOptions, measure: (record: object) => number }} ViewContext
 * @typedef {{ id: string, name: string, tz: string }} Tenant
 * @typedef {{ query: string, as: string }} Via
 * @typedef {{ state: string, missing: readonly string[] }} CoverageView
 * @typedef {{ view: string, scope: Record<string, unknown>, outcome: Outcome | null, coverage: CoverageView | null, checked: number | null, eligible: number | null, asof: string, rules: string | null, stale: string | null }} Head
 * @typedef {{ utc: string, local: string, tz: string, [extra: string]: unknown }} Anchor
 * @typedef {{ v: 1, view: string, head: Head, anchor: Anchor | null, via: Via | null, records: object[], gaps: object[], page: Page | null, next: string[] }} View
 */

const SEVERITY = /** @type {const} */ (["broken", "degraded", "expected", "unknown", "healthy"]);
const rank = (/** @type {string} */ outcome) => String(SEVERITY.findIndex((entry) => entry === outcome)).padStart(2, "0");
/** Sort keys stay short because a cursor carries one: time in fixed-width base 36, then a short id. */
const pad = (/** @type {number} */ ms) => Math.max(0, ms).toString(36).padStart(9, "0");
const short = (/** @type {string} */ id) => id.replaceAll("-", "").slice(0, 12);
/** @param {Item["kind"]} kind */
export const refKind = (kind) => (kind === "attempt" ? "client_session" : kind);
/** @param {Item} item */
const itemRef = (item) => (item.kind === "platform" ? item.id : ref(refKind(item.kind), item.id));

/**
 * The header scope of a day item: `space spc_x 2026-11-18`, `tenant ten_x 2026-11-18`, `platform production 2026-11-18`.
 * @param {import("../proof/profile.mjs").Declaration} declaration
 */
const dayScope = (declaration) => {
  if (declaration.kind === "platform") return { item: declaration.id, date: declaration.day };
  if (declaration.kind === "space" || declaration.kind === "tenant") return { item: ref(declaration.kind, declaration.id), date: declaration.day };
  return null;
};

/**
 * The worst proven outcome among several, and `healthy` only when every one is healthy.
 * @param {readonly Outcome[]} outcomes
 * @returns {Outcome}
 */
export function combine(outcomes) {
  for (const outcome of /** @type {const} */ (["broken", "degraded", "expected"])) if (outcomes.includes(outcome)) return outcome;
  return outcomes.length > 0 && outcomes.every((outcome) => outcome === "healthy") ? "healthy" : "unknown";
}

/**
 * @param {Declaration} declaration
 * @param {string} subject
 * @returns {Party}
 */
function partyOf(declaration, subject) {
  if (declaration.kind !== "episode" || subject === "*") return "all";
  const id = subject.slice(3);
  const seat = declaration.seats.find((candidate) => candidate.participant === id);
  return { ref: ref("participant", id), name: seat?.name ?? null };
}

/** The handle `participant` takes for the person behind a seat: their User or Agent, or the seat itself for a guest. */
function personRef(/** @type {Declaration} */ declaration, /** @type {string} */ subject) {
  if (declaration.kind !== "episode" || subject === "*") return null;
  const seat = declaration.seats.find((candidate) => `pt:${candidate.participant}` === subject);
  if (!seat) return null;
  return seat.person.kind === "guest" ? ref("participant", seat.participant) : ref(seat.person.kind, seat.person.id);
}

/** The first evidence a finding cites: rules list their most telling fact first. */
const primaryEvidence = (/** @type {Finding} */ finding) => finding.facts.flatMap((fact) => fact.evidence)[0] ?? null;

/**
 * @param {Verdict | null} verdict
 * @param {Status} status
 * @returns {CoverageView}
 */
function coverageOf(verdict, status) {
  if (status.state === "unchecked" || verdict === null) return { state: "unchecked", missing: [] };
  const missing = [...new Set(verdict.coverage.gaps.map((gap) => (gap.kind === "check" ? area(gap.code) : gap.kind)))].sort();
  if (status.state === "stale") return { state: "stale", missing: [status.why, ...missing] };
  return { state: verdict.coverage.state, missing };
}

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
 * One Episode, attempt or job in depth: the only view with relative times.
 * @param {{ item: Item, status: Status, tenant: Tenant, ctx: ViewContext, via?: Via | null }} input
 * @returns {View}
 */
export function itemView({ item, status, tenant, ctx, via = null }) {
  const { outcome, verdict } = standing(status);
  const declaration = item.declaration;
  const anchorMs = declaration.window.from_ms;
  const at = (/** @type {number} */ ms) => relative(ms, anchorMs);
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

/** @typedef {{ key: string } & Record<string, unknown>} Keyed */
/** @typedef {(ms: number) => string} At */

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
  const at = (/** @type {number} */ ms) => relative(ms, anchorMs);
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

/**
 * @typedef {{ item: Item, status: Status }} Entry
 */

/** A scope that holds no item proves nothing, so it is a gap, never an all-clear. */
const EMPTY = Object.freeze({ t: "gap", code: "empty", why: "no item in scope" });

/**
 * Items that are not current and complete are gaps of an aggregate view, never paged.
 * @param {readonly Entry[]} entries
 * @param {(ms: number) => string} when
 * @returns {object[]}
 */
function itemGaps(entries, when) {
  return entries
    .map(({ item, status }) => {
      const { verdict, outcome } = standing(status);
      const coverage = coverageOf(verdict, status);
      if (status.state === "current" && coverage.state === "complete") return null;
      const state = status.state === "current" ? "partial" : status.state;
      return { key: `${pad(item.declaration.window.from_ms)}|${short(item.id)}`, t: "item", state, item: itemRef(item), when: when(item.declaration.window.from_ms), missing: status.state === "current" ? coverage.missing : [], was: status.state === "stale" ? status.stored.verdict.outcome : null };
    })
    .filter((gap) => gap !== null)
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map(({ key: _key, ...gap }) => gap);
}

/**
 * Head fields shared by views over many items. `kept` is the outcomes of the findings a filtered view shows (a person's, a symptom's):
 * its outcome is theirs, so a guest with no finding in a broken Episode is not called broken, and is healthy only when every item it
 * covers is current and complete.
 * @param {readonly Entry[]} entries
 * @param {ViewContext} ctx
 * @param {readonly Outcome[] | null} [kept]
 */
function aggregate(entries, ctx, kept = null) {
  const standings = entries.map(({ status }) => ({ status, ...standing(status) }));
  const current = standings.filter(({ status }) => status.state === "current").length;
  const counts = { partial: 0, stale: 0, unchecked: 0 };
  for (const { status, coverage } of standings) {
    if (status.state === "unchecked") counts.unchecked += 1;
    else if (status.state === "stale") counts.stale += 1;
    else if (coverage !== "complete") counts.partial += 1;
  }
  const missing = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`);
  const state = entries.length === 0 ? "partial" : missing.length === 0 ? "complete" : current === 0 && counts.stale === 0 ? "unchecked" : "partial";
  const proven = kept === null ? combine(standings.map(({ outcome }) => outcome)) : combine(kept);
  const outcome = kept !== null && kept.length === 0 ? (state === "complete" && entries.length > 0 ? "healthy" : "unknown") : proven;
  return { outcome, coverage: { state, missing }, checked: current, eligible: entries.length, asof: isoMinute(ctx.asof_ms), rules: ctx.rules, stale: null };
}

/**
 * Findings of many items grouped by symptom code: one record per code, worst first.
 * @param {readonly Entry[]} entries
 * @param {(finding: Finding, item: Item) => boolean} keep
 */
function groups(entries, keep) {
  /** @type {Map<string, { outcomes: Outcome[], items: Item[], people: Set<string> }>} */
  const byCode = new Map();
  for (const { item, status } of entries) {
    for (const finding of standing(status).verdict?.findings ?? []) {
      if (!keep(finding, item)) continue;
      const group = byCode.get(finding.code) ?? { outcomes: [], items: [], people: new Set() };
      group.outcomes.push(/** @type {Outcome} */ (finding.outcome));
      if (!group.items.includes(item)) group.items.push(item);
      if (finding.subject !== "*") group.people.add(JSON.stringify(personRef(item.declaration, finding.subject)));
      byCode.set(finding.code, group);
    }
  }
  return [...byCode.entries()].map(([code, group]) => {
    const outcome = combine(group.outcomes);
    const shown = group.items.slice(0, 3);
    return { key: `${rank(outcome)}|${code}`, t: "group", code, outcome, kind: group.items[0].kind, count: group.items.length, people: group.people.size > 0 ? group.people.size : null, items: shown.map(itemRef), more: group.items.length - shown.length };
  });
}

/**
 * One tenant's day in its own time zone: symptom groups, then every item that is unchecked, stale or partial.
 * @param {{ tenant: Tenant, date: string, entries: readonly Entry[], ctx: ViewContext, symptom?: string | null, via?: Via | null }} input
 * @returns {View}
 */
export function dayView({ tenant, date, entries, ctx, symptom = null, via = null }) {
  const midnight = localMidnight(date, tenant.tz);
  const records = groups(entries, (/** @type {Finding} */ finding) => symptom === null || finding.code === symptom).sort((a, b) => (a.key < b.key ? -1 : 1));
  const paged = page(records, `day:${tenant.id}:${date}:${symptom ?? ""}`, ctx.paging, ctx.measure);
  const gaps = itemGaps(entries, (ms) => localWhen(ms, tenant.tz));
  if (entries.length === 0) gaps.push(EMPTY);
  const keep = (/** @type {Finding} */ finding) => symptom === null || finding.code === symptom;
  const kept = symptom === null ? null : entries.flatMap(({ status }) => (standing(status).verdict?.findings ?? []).filter(keep).map((finding) => finding.outcome));
  const head = { view: "day", scope: { tenant: tenant.name, date, ...(symptom ? { symptom } : {}) }, ...aggregate(entries, ctx, kept) };
  const next = [];
  if (gaps.some((gap) => "state" in gap && (gap.state === "unchecked" || gap.state === "stale"))) next.push(["check", tenant.name, date]);
  const firstGroup = paged.records[0];
  if (firstGroup && "items" in firstGroup && Array.isArray(firstGroup.items) && firstGroup.items[0]) next.push([firstGroup.items[0].$h === "client_session" ? "attempt" : firstGroup.items[0].$h === "job" ? "job" : "episode", firstGroup.items[0]]);
  if (paged.page.cursor) next.push(["day", tenant.name, date, ...(symptom ? ["--symptom", symptom] : []), "--cursor", paged.page.cursor]);
  return finish({ view: "day", head, anchor: { utc: isoMinute(midnight), local: localAnchor(midnight, tenant.tz, true), tz: tenant.tz }, via, records: paged.records, gaps, page: paged.page, next });
}

/**
 * Findings across a date range, for one person (`participant`) or one symptom (`pattern`). A Participant is a per-Episode seat, so the
 * person view keys on the User or Agent behind the seats; a guest has none, and the resolver offers candidate seats instead.
 * `check` is the argument list of the `check` command that covers the same scope, offered when some item is unchecked or stale.
 * @param {{ title: { view: "participant" | "pattern" | "window", scope: Record<string, unknown> }, tenantTz: string, range: { from_ms: number, to_ms: number }, entries: readonly Entry[], keep: (finding: Finding, item: Item) => boolean, check: readonly string[], again: readonly unknown[], ctx: ViewContext, via?: Via | null }} input
 * @returns {View}
 */
export function rangeView({ title, tenantTz, range, entries, keep, check, again, ctx, via = null }) {
  const when = (/** @type {number} */ ms) => localWhen(ms, tenantTz, true);
  /** @type {({ key: string } & Record<string, unknown>)[]} */
  const records = groups(entries, keep);
  for (const { item, status } of entries) {
    for (const finding of standing(status).verdict?.findings ?? []) {
      if (!keep(finding, item)) continue;
      const primary = primaryEvidence(finding);
      records.push({
        key: `9|${pad(finding.window.from_ms)}|${short(finding.id)}`,
        t: "finding",
        f: ref("finding", finding.id),
        outcome: finding.outcome,
        code: finding.code,
        item: itemRef(item),
        party: title.view === "pattern" ? partyOf(item.declaration, finding.subject) : null,
        when: when(finding.window.from_ms),
        hop: finding.hop,
        module: finding.module,
        upstream: finding.upstream,
        reason: finding.reason,
        ev: primary === null ? null : ref("event", primary),
        retained: finding.retained !== null,
      });
    }
  }
  records.sort((a, b) => (a.key < b.key ? -1 : 1));
  const paged = page(records, `${title.view}:${JSON.stringify(title.scope)}:${range.from_ms}:${range.to_ms}`, ctx.paging, ctx.measure);
  const gaps = itemGaps(entries, when);
  if (entries.length === 0) gaps.push(EMPTY);
  const kept = entries.flatMap(({ item, status }) => (standing(status).verdict?.findings ?? []).filter((finding) => keep(finding, item)).map((finding) => /** @type {Outcome} */ (finding.outcome)));
  const head = { view: title.view, scope: { ...title.scope, range: `${localWhen(range.from_ms, tenantTz, true).slice(0, 5)}..${localWhen(range.to_ms - 1, tenantTz, true).slice(0, 5)}` }, ...aggregate(entries, ctx, kept) };
  const next = [];
  if (gaps.some((gap) => "state" in gap && (gap.state === "unchecked" || gap.state === "stale"))) next.push(["check", ...check]);
  const latest = paged.records.filter((record) => record.t === "finding").at(-1);
  if (latest && "f" in latest) next.push(["evidence", latest.f]);
  if (paged.page.cursor) next.push([...again, "--cursor", paged.page.cursor]);
  return finish({ view: title.view, head, anchor: { utc: isoMinute(range.from_ms), local: localAnchor(range.from_ms, tenantTz, true), tz: tenantTz }, via, records: paged.records, gaps, page: paged.page, next });
}

/**
 * What one `check` run did: each item it checked, rechecked or found current.
 * @param {{ scope: Record<string, unknown>, tz: string, results: readonly { item: Item, action: string, was: Outcome | null, verdict: Verdict }[], ctx: ViewContext, again: readonly string[] }} input
 * @returns {View}
 */
export function checkView({ scope, tz, results, ctx, again }) {
  const entries = results.map(({ item, verdict }) => ({ item, status: /** @type {Status} */ ({ state: "current", stored: { item, declaration: "", fingerprint: "", verdict } }) }));
  const records = results
    .map(({ item, action, was, verdict }) => ({
      key: `${pad(item.declaration.window.from_ms)}|${short(item.id)}`,
      t: "item",
      state: action,
      item: itemRef(item),
      when: localWhen(item.declaration.window.from_ms, tz, true),
      outcome: verdict.outcome,
      coverage: coverageOf(verdict, { state: "current", stored: { item, declaration: "", fingerprint: "", verdict } }),
      codes: [...new Set(verdict.findings.map((finding) => finding.code))],
      was: action === "rechecked" ? was : null,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const paged = page(records, `check:${JSON.stringify(scope)}`, ctx.paging, ctx.measure);
  const gaps = itemGaps(entries, (ms) => localWhen(ms, tz, true));
  if (entries.length === 0) gaps.push(EMPTY);
  const head = { view: "check", scope, ...aggregate(entries, ctx) };
  const next = [];
  const worst = results.find(({ verdict }) => verdict.outcome === "broken" || verdict.outcome === "degraded");
  if (worst) next.push([worst.item.kind, itemRef(worst.item)]);
  if (paged.page.cursor) next.push([...again, "--cursor", paged.page.cursor]);
  return finish({ view: "check", head, anchor: { utc: isoMinute(ctx.asof_ms), local: localAnchor(ctx.asof_ms, tz, true), tz }, via: null, records: paged.records, gaps, page: paged.page, next });
}

/**
 * @typedef {{ kind: string, id: string, label: string, tenant: string | null, meaning: string | null, when_ms: number | null }} Candidate
 */

/**
 * The candidates for an ambiguous lookup. Never a silent pick: each candidate is a line, and the agent chooses.
 * @param {{ query: string, candidates: readonly Candidate[], ctx: ViewContext, tz: string, carry?: readonly string[] }} input `carry` is
 *   arguments the query gave (a date range) that each candidate's next command keeps
 * @returns {View}
 */
export function resolveView({ query, candidates, ctx, tz, carry = [] }) {
  const records = candidates
    .map((candidate) => ({
      key: `${candidate.kind}|${candidate.label}|${short(candidate.id)}`,
      t: "candidate",
      ref: ref(candidate.kind, candidate.id),
      kind: candidate.kind,
      label: candidate.label,
      tenant: candidate.tenant,
      meaning: candidate.meaning,
      when: candidate.when_ms === null ? null : localWhen(candidate.when_ms, tz, true),
    }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  const paged = page(records, `resolve:${query}`, ctx.paging, ctx.measure);
  /** @type {Head} */
  const head = { view: "resolve", scope: { query }, outcome: null, coverage: null, checked: null, eligible: null, asof: isoMinute(ctx.asof_ms), rules: null, stale: null };
  /** @type {unknown[][]} */
  const next = paged.records.map((record) => [record.ref, ...carry]);
  if (paged.page.cursor) next.push(["resolve", quoteArg(query), ...carry, "--cursor", paged.page.cursor]);
  return finish({ view: "resolve", head: { ...head, scope: { query, matched: candidates.length } }, anchor: null, via: null, records: paged.records, gaps: [], page: paged.page, next });
}

/**
 * Turns `next` argument lists into commands and every Ref into a scope-unique handle, in one pass, so a handle in a `next:` line is
 * the same string as in the record above it.
 * @param {Omit<View, "v" | "next"> & { next: unknown[][] }} view
 * @returns {View}
 */
function finish(view) {
  const finalized = finalizeHandles({ v: /** @type {const} */ (1), ...view });
  return { ...finalized, next: finalized.next.map((parts) => ["diagnose", ...parts.map(String)].join(" ")) };
}

/** Quotes an argument for a `next:` line only when a shell would split it. */
export const quoteArg = (/** @type {string} */ value) => (/^[\w.:@/+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
