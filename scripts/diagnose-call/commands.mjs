// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
// The verdict commands that open one thing: an item, a resolved entry, a day, or a check run on demand.
import { BACKSTOPS } from "./proof/verdict.mjs";
import { check, standing } from "./proof/check.mjs";
import { localDate, localMidnight, ref } from "./output/format.mjs";
import { UsageError } from "./output/page.mjs";
import { realDate } from "./output/query.mjs";
import { resolve } from "./output/resolve.mjs";
import { evidenceView, itemView } from "./output/item-views.mjs";
import { checkView } from "./output/lookup-views.mjs";
import { dayView, quoteArg, rangeView, refKind } from "./output/views.mjs";
import { UTC_TENANT, candidates, itemsIn, statusFor, tenantOf, rangeOf, rangeArgs, dateArg, nextDate, need, describe } from "./scope.mjs";

/** @typedef {import("./output/views.mjs").View} View */
/** @typedef {import("./output/views.mjs").Tenant} Tenant */
/** @typedef {import("./output/resolve.mjs").Entry} Entry */
/** @typedef {import("./output/query.mjs").Query} Query */
/** @typedef {import("./diagnose.mjs").Session} Session */
/** @typedef {import("./diagnose.mjs").Command} Command */
/** @typedef {{ scope: import("./proof/check.mjs").Scope, shown: Record<string, unknown>, tz: string } | { view: View }} CheckTarget */

/** A symptom is a check's code or a backstop; a misspelt one would read as a clean scope, so it is a usage error. */
export function symptomCode(/** @type {Session} */ session, /** @type {string} */ code) {
  /** @type {readonly string[]} */
  const known = [...session.ctx.catalogue.map((def) => def.code), ...BACKSTOPS];
  if (!known.includes(code)) throw new UsageError(`unknown symptom ${code}; known: ${known.join(", ")}`);
  return code;
}

/**
 * `episode`, `attempt` and `job` open one item of that kind; a finding or session id that names the item resolves to it, and says so.
 * @param {"episode" | "attempt" | "job"} command
 * @returns {Command}
 */
export function openItem(command) {
  return (query, session, tenantScope) => {
    const text = need(query.args, `the ${command}`).join(" ");
    const matches = itemMatches(session, text, tenantScope, command);
    if (matches.length !== 1)
      return candidates(
        session,
        text,
        matches.map((match) => match.entry),
      );
    const { entry, item } = matches[0];
    return itemView({ item, status: statusFor(session, item), tenant: tenantOf(session, item.tenant), ctx: session.ctx, via: entry.kind === refKind(command) ? null : { query: text, as: describe(entry) } });
  };
}

/**
 * Opens what a single lookup match names.
 * @param {Session} session
 * @param {Entry} entry
 * @param {Query} query
 * @param {import("./output/views.mjs").Via | null} via
 * @returns {View}
 */
export function openEntry(session, entry, query, via) {
  const target = entry.target;
  if (target.kind === "item") return itemView({ item: target.item, status: statusFor(session, target.item), tenant: tenantOf(session, target.item.tenant), ctx: session.ctx, via });
  if (target.kind === "finding") {
    const status = statusFor(session, target.item);
    const finding = standing(status).verdict?.findings.find((candidate) => candidate.id === target.finding);
    if (!finding) throw new TypeError(`finding ${target.finding} is not in its item's stored verdict`);
    return evidenceView({ item: target.item, status, finding, tenant: tenantOf(session, target.item.tenant), ctx: session.ctx, via });
  }
  if (target.kind === "tenant") {
    const tenant = tenantOf(session, target.tenant);
    return day(session, tenant, localDate(session.ctx.asof_ms, tenant.tz), query.options.symptom);
  }
  const tenant = tenantOf(session, target.tenant);
  const range = rangeOf(session, query.options, tenant.tz, 30);
  const person = target.person;
  /** @type {(item: Item) => string[]} */
  const seatsOf = (item) => {
    const declaration = item.declaration;
    if (declaration.kind !== "episode") return [];
    if (person.kind === "seat") return person.item.id === item.id ? [person.participant] : [];
    return declaration.seats.filter((seat) => seat.person.kind === person.kind && seat.person.id === person.id).map((seat) => seat.participant);
  };
  const entries = itemsIn(session, tenant.id, range).filter(({ item }) => seatsOf(item).length > 0);
  const who = person.kind === "seat" ? { ref: ref("participant", person.participant), name: entry.name } : { ref: ref(person.kind, person.id), name: session.world.people.find((candidate) => candidate.kind === person.kind && candidate.id === person.id)?.name ?? null };
  const scopeArgs = ["--tenant", tenant.name, ...rangeArgs(query.options, range)];
  return rangeView({
    title: { view: "participant", scope: { who, tenant: tenant.name } },
    tenantTz: tenant.tz,
    range,
    entries,
    keep: (finding, item) => seatsOf(item).some((participant) => finding.subject === `pt:${participant}`),
    check: scopeArgs,
    again: ["participant", who.ref, ...scopeArgs],
    ctx: session.ctx,
    via,
  });
}

/**
 * @param {Session} session
 * @param {Query} query
 * @param {Tenant | null} tenantScope
 */
export async function runCheck(session, query, tenantScope) {
  const target = checkTarget(session, query, tenantScope);
  if ("view" in target) return target.view;
  const results = await check(target.scope, session.ports, { catalogue: session.ctx.catalogue, rules: session.ctx.rules, asof_ms: session.ctx.asof_ms });
  return checkView({ scope: target.shown, tz: target.tz, results, ctx: session.ctx, again: checkAgain(query, tenantScope) });
}

/**
 * What `check` covers: one item named by any handle, a tenant's day, or a range. An item lookup that is not exactly one item returns candidates.
 * @param {Session} session
 * @param {Query} query
 * @param {Tenant | null} tenantScope
 * @returns {CheckTarget}
 */
function checkTarget(session, query, tenantScope) {
  const { args, options } = query;
  const tenantArg = args.length > 0 ? resolve(session.entries, args[0], { kinds: ["tenant"] }) : [];
  if (args.length > 0 && tenantArg.length === 0) return checkItem(session, args.join(" "), tenantScope);
  const tenant = tenantArg.length === 1 ? tenantOf(session, tenantArg[0].id) : tenantScope;
  const tz = tenant?.tz ?? "UTC";
  if (args[1] !== undefined && tenant) {
    const date = dateArg(session, tenant, args[1]);
    return { scope: { tenant: tenant.id, from_ms: localMidnight(date, tenant.tz), to_ms: localMidnight(nextDate(date), tenant.tz) }, shown: { tenant: tenant.name, date }, tz };
  }
  const range = rangeOf(session, options, tz, 1);
  return { scope: { tenant: tenant?.id ?? null, ...range }, shown: { tenant: tenant?.name ?? "all", since: options.since ?? (options.from ? `${options.from}..${options.to}` : "1d") }, tz };
}

/** @param {Session} session @param {string} text @param {Tenant | null} tenantScope @returns {CheckTarget} */
function checkItem(session, text, tenantScope) {
  const matches = itemMatches(session, text, tenantScope, null);
  if (matches.length !== 1)
    return {
      view: candidates(
        session,
        text,
        matches.map((match) => match.entry),
      ),
    };
  const { item } = matches[0];
  return { scope: { item: { kind: item.kind, id: item.id } }, shown: { item: ref(refKind(item.kind), item.id) }, tz: tenantOf(session, item.tenant).tz };
}

/** The arguments that rerun this check, so its cursor `next:` reaches the same scope. @param {Query} query @param {Tenant | null} tenantScope */
function checkAgain({ args, options }, tenantScope) {
  return ["check", ...args.map(quoteArg), ...(tenantScope ? ["--tenant", tenantScope.name] : []), ...(options.since ? ["--since", options.since] : []), ...(options.from && options.to ? ["--from", quoteArg(options.from), "--to", quoteArg(options.to)] : [])];
}

/** @param {Session} session @param {Tenant} tenant @param {string} date @param {string | null} symptom */
export function day(session, tenant, date, symptom) {
  const range = { from_ms: localMidnight(date, tenant.tz), to_ms: localMidnight(nextDate(date), tenant.tz) };
  return dayView({ tenant, date, entries: itemsIn(session, tenant.id, range), ctx: session.ctx, symptom });
}

/**
 * Opens one UTC day of a Space, a Tenant or the platform: `space spc_x 2026-11-18`, `tenant ten_x 2026-11-18` or
 * `platform production 2026-11-18`. Unlike `day`, which sweeps a tenant's Episodes, this opens the day item itself and its checks.
 * @param {"space" | "tenant" | "platform"} command
 * @returns {Command}
 */
export function openDay(command) {
  return (query, session, tenantScope) => {
    const [what, date] = need(query.args, command === "platform" ? "an environment and a date" : `a ${command} and a date`);
    if (date === undefined || !realDate(date)) throw new UsageError(`diagnose ${command} <${command === "platform" ? "environment" : command}> <YYYY-MM-DD>: the day is a UTC date like 2026-11-18`);
    const named = command === "platform" ? [] : resolve(session.entries, what, { tenant: tenantScope?.id ?? null, kinds: [command] });
    const ids = command === "platform" ? [what] : named.map((entry) => entry.id);
    const found = session.items.filter((item) => item.declaration.kind === command && ids.includes(item.id) && item.declaration.day === date);
    if (found.length !== 1) {
      if (command === "platform") throw new UsageError(`no platform day ${what} ${date} in the world`);
      return candidates(session, what, named);
    }
    const [item] = found;
    const tenant = item.tenant === null ? UTC_TENANT : tenantOf(session, item.tenant);
    return itemView({ item, status: statusFor(session, item), tenant, ctx: session.ctx });
  };
}

/**
 * The items `text` names, directly or through one of their findings, one match per item. `kind` keeps only items of that kind.
 * @param {Session} session @param {string} text @param {Tenant | null} tenantScope @param {"episode" | "attempt" | "job" | null} kind
 */
function itemMatches(session, text, tenantScope, kind) {
  const found = resolve(session.entries, text, { tenant: tenantScope?.id ?? null }).flatMap((entry) => ((entry.target.kind === "item" || entry.target.kind === "finding") && (kind === null || entry.target.item.kind === kind) ? [{ entry, item: entry.target.item }] : []));
  return [...new Map(found.map((match) => [match.item.id, match])).values()];
}
