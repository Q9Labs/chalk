// @ts-check
// The views of a check run on demand and of a lookup that matched more than one thing.
import { isoMinute, localAnchor, localWhen, ref } from "./format.mjs";
import { page } from "./page.mjs";
import { EMPTY, aggregate, coverageOf, finish, itemGaps, itemRef, pad, quoteArg, short } from "./views.mjs";

/** @typedef {import("./views.mjs").Candidate} Candidate */
/** @typedef {import("./views.mjs").Head} Head */
/** @typedef {import("../proof/check.mjs").Item} Item */
/** @typedef {import("../proof/verdict.mjs").Outcome} Outcome */
/** @typedef {import("../proof/check.mjs").Status} Status */
/** @typedef {import("../proof/verdict.mjs").Verdict} Verdict */
/** @typedef {import("./views.mjs").View} View */
/** @typedef {import("./views.mjs").ViewContext} ViewContext */

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
