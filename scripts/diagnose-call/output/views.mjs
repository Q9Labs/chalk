// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * Views: the one model both output forms render. Text (text.mjs) and `--json` (json.mjs) are two encodings of the same view, so
 * they cannot drift apart in content. A view has a head (line 1), an anchor (line 2), an optional `via` (how a lookup resolved),
 * records (paged), gaps (never paged) and `next` commands.
 */
import { standing } from "../proof/check.mjs";
import { area, finalizeHandles, isoMinute, localAnchor, localDate, localMidnight, localWhen, ref, relative } from "./format.mjs";
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
 * @typedef {{ view: string, scope: Record<string, unknown>, outcome: Outcome | null, coverage: CoverageView | null, checked: number | null, eligible: number | null, asof: string, rules: string | null, stale: string | null, read?: "fresh" }} Head
 * @typedef {{ utc: string, local: string, tz: string, [extra: string]: unknown }} Anchor
 * @typedef {{ v: 1, view: string, head: Head, anchor: Anchor | null, via: Via | null, records: object[], gaps: object[], page: Page | null, next: string[] }} View
 */

const SEVERITY = /** @type {const} */ (["broken", "degraded", "expected", "unknown", "healthy"]);
const rank = (/** @type {string} */ outcome) => String(SEVERITY.findIndex((entry) => entry === outcome)).padStart(2, "0");
/** Sort keys stay short because a cursor carries one: time in fixed-width base 36, then a short id. */
export const pad = (/** @type {number} */ ms) => Math.max(0, ms).toString(36).padStart(9, "0");
export const short = (/** @type {string} */ id) => id.replaceAll("-", "").slice(0, 12);
/** @param {Item["kind"]} kind */
export const refKind = (kind) => (kind === "attempt" ? "client_session" : kind);
/** @param {Item} item */
export const itemRef = (item) => (item.kind === "platform" ? item.id : ref(refKind(item.kind), item.id));

/**
 * The header scope of a day item: `space spc_x 2026-11-18`, `tenant ten_x 2026-11-18`, `platform production 2026-11-18`.
 * @param {import("../proof/profile.mjs").Declaration} declaration
 */
export const dayScope = (declaration) => {
  if (declaration.kind === "platform") return { item: declaration.id, date: declaration.day };
  if (declaration.kind === "space" || declaration.kind === "tenant") return { item: ref(declaration.kind, declaration.id), date: declaration.day };
  return null;
};

/**
 * How an item prints the times in its finding, fact and gap lines. A day item prints UTC `HH:MM`, since its header names the date
 * (`MM-DD HH:MM` for a time on another day); an Episode, attempt or job prints `+07:10` from its start.
 * @param {import("../proof/profile.mjs").Declaration} declaration
 * @returns {At}
 */
export const itemClock = (declaration) => {
  if (declaration.kind === "space" || declaration.kind === "tenant" || declaration.kind === "platform") {
    const { day } = declaration;
    return (ms) => localWhen(ms, "UTC", localDate(ms, "UTC") !== day);
  }
  return (ms) => relative(ms, declaration.window.from_ms);
};

/**
 * The worst proven outcome among several, and `healthy` only when every one is healthy.
 * @param {readonly Outcome[]} outcomes
 * @returns {Outcome}
 */
function combine(outcomes) {
  for (const outcome of /** @type {const} */ (["broken", "degraded", "expected"])) if (outcomes.includes(outcome)) return outcome;
  return outcomes.length > 0 && outcomes.every((outcome) => outcome === "healthy") ? "healthy" : "unknown";
}

/**
 * @param {Declaration} declaration
 * @param {string} subject
 * @returns {Party}
 */
export function partyOf(declaration, subject) {
  if (declaration.kind !== "episode" || subject === "*") return "all";
  const id = subject.slice(3);
  const seat = declaration.seats.find((candidate) => candidate.participant === id);
  return { ref: ref("participant", id), name: seat?.name ?? null };
}

/** The handle `participant` takes for the person behind a seat: their User or Agent, or the seat itself for a guest. */
export function personRef(/** @type {Declaration} */ declaration, /** @type {string} */ subject) {
  if (declaration.kind !== "episode" || subject === "*") return null;
  const seat = declaration.seats.find((candidate) => `pt:${candidate.participant}` === subject);
  if (!seat) return null;
  return seat.person.kind === "guest" ? ref("participant", seat.participant) : ref(seat.person.kind, seat.person.id);
}

/** The first evidence a finding cites: rules list their most telling fact first. */
export const primaryEvidence = (/** @type {Finding} */ finding) => finding.facts.flatMap((fact) => fact.evidence)[0] ?? null;

/**
 * @param {Verdict | null} verdict
 * @param {Status} status
 * @returns {CoverageView}
 */
export function coverageOf(verdict, status) {
  if (status.state === "unchecked" || verdict === null) return { state: "unchecked", missing: [] };
  const missing = [...new Set(verdict.coverage.gaps.map((gap) => (gap.kind === "check" ? area(gap.code) : gap.kind)))].sort();
  if (status.state === "stale") return { state: "stale", missing: [status.why, ...missing] };
  return { state: verdict.coverage.state, missing };
}

/** @typedef {{ key: string } & Record<string, unknown>} Keyed */
/**
 * A record a slice shows beside its findings (an upload readback, a webhook delivery), printed as `<kind> <handle> key=value`.
 * @typedef {{ t: "related", kind: string, ref: Ref, fields: Readonly<Record<string, string | number>> }} Related
 */
/** @typedef {(ms: number) => string} At */

/**
 * @typedef {{ item: Item, status: Status }} Entry
 */

/** A scope that holds no item proves nothing, so it is a gap, never an all-clear. */
export const EMPTY = Object.freeze({ t: "gap", code: "empty", why: "no item in scope" });

/**
 * Items that are not current and complete are gaps of an aggregate view, never paged.
 * @param {readonly Entry[]} entries
 * @param {(ms: number) => string} when
 * @returns {object[]}
 */
export function itemGaps(entries, when) {
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
export function aggregate(entries, ctx, kept = null) {
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
        party: partyOf(item.declaration, finding.subject),
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
 * @typedef {{ kind: string, id: string, label: string, tenant: string | null, meaning: string | null, when_ms: number | null }} Candidate
 */

/**
 * Turns `next` argument lists into commands and every Ref into a scope-unique handle, in one pass, so a handle in a `next:` line is
 * the same string as in the record above it.
 * @param {Omit<View, "v" | "next"> & { next: unknown[][] }} view
 * @returns {View}
 */
export function finish(view) {
  const finalized = finalizeHandles({ v: /** @type {const} */ (1), ...view });
  return { ...finalized, next: finalized.next.map((parts) => ["diagnose", ...parts.map(String)].join(" ")) };
}

/** Quotes an argument for a `next:` line only when a shell would split it. */
export const quoteArg = (/** @type {string} */ value) => (/^[\w.:@/+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);
