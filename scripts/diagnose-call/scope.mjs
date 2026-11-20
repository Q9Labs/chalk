// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
// Resolves what a diagnose command looks at from its arguments: the Tenant and its time zone, a day or a range of days, and the
// items inside them.
import { localDate, localMidnight } from "./output/format.mjs";
import { UsageError } from "./output/page.mjs";
import { instant, realDate } from "./output/query.mjs";
import { isHandle, resolve } from "./output/resolve.mjs";
import { resolveView } from "./output/lookup-views.mjs";
import { quoteArg } from "./output/views.mjs";

/** @typedef {import("./output/views.mjs").Tenant} Tenant */
/** @typedef {import("./output/query.mjs").Query} Query */
/** @typedef {import("./proof/check.mjs").Item} Item */
/** @typedef {import("./proof/check.mjs").Status} Status */
/** @typedef {import("./diagnose.mjs").Session} Session */

const DAY_MS = 86_400_000;

/** The platform belongs to no tenant, so its day prints in UTC. */
export const UTC_TENANT = Object.freeze({ id: "", name: "platform", tz: "UTC" });

/**
 * @param {Session} session
 * @param {string} query
 * @param {readonly Entry[]} found
 * @param {Query["options"] | null} [range] a range the query asked for, carried into each candidate's next command
 */
export function candidates(session, query, found, range = null) {
  const elsewhere = found.length === 0 && isHandle(query) ? resolve(session.entries, query) : [];
  if (elsewhere.length === 1) throw new UsageError(`${query} names ${describe(elsewhere[0])}, not what this command opens; run diagnose ${query}`);
  const carry = range === null || (range.since === null && range.from === null) ? [] : rangeArgs(range, rangeOf(session, range, "UTC", 30));
  return resolveView({ query, candidates: found, ctx: session.ctx, tz: "UTC", carry });
}

const SWEPT = new Set(["episode", "attempt", "job"]);

/**
 * Episodes, attempts and jobs of a tenant (or every tenant) that started inside a range, with their status. A Space, Tenant or platform
 * day is an aggregate of those items, so a sweep leaves it out and its own command (`space`, `tenant`, `platform`) opens it.
 */
export function itemsIn(/** @type {Session} */ session, /** @type {string | null} */ tenant, /** @type {{ from_ms: number, to_ms: number }} */ range) {
  return session.items.filter((item) => SWEPT.has(item.kind) && (tenant === null || item.tenant === tenant) && item.declaration.window.from_ms >= range.from_ms && item.declaration.window.from_ms < range.to_ms).map((item) => ({ item, status: statusFor(session, item) }));
}

/** @param {Session} session @param {Item} item @returns {Status} */
export const statusFor = (session, item) => /** @type {Status} */ (session.statuses.get(item));

/** @param {Session} session @param {string} id @returns {Tenant} */
export function tenantOf(session, id) {
  const tenant = session.world.tenants.find((candidate) => candidate.id === id);
  if (!tenant) throw new TypeError(`no tenant ${id} in the world`);
  return tenant;
}

/** @param {Session} session @param {string} text @returns {Tenant} */
export function tenantNamed(session, text) {
  const found = resolve(session.entries, text, { kinds: ["tenant"] });
  if (found.length !== 1) throw new UsageError(found.length === 0 ? `no tenant matches ${JSON.stringify(text)}` : `${JSON.stringify(text)} matches ${found.length} tenants: ${found.map((entry) => entry.label).join(", ")}`);
  return tenantOf(session, found[0].id);
}

/**
 * The range a command covers: --from/--to, else --since, else the default number of days before asof.
 * @param {Session} session
 * @param {Query["options"]} options
 * @param {string} tz
 * @param {number} days
 */
export function rangeOf(session, options, tz, days) {
  const midnight = (/** @type {string} */ date) => localMidnight(date, tz);
  if (options.from !== null || options.to !== null) {
    if (options.from === null || options.to === null) throw new UsageError("--from and --to go together");
    const from_ms = instant(options.from, midnight);
    const to_ms = /^\d{4}-\d{2}-\d{2}$/u.test(options.to) ? localMidnight(nextDate(options.to), tz) : instant(options.to, midnight);
    if (to_ms <= from_ms) throw new UsageError("--to must be after --from");
    return { from_ms, to_ms };
  }
  const n = options.since === null ? days : Number(options.since.slice(0, -1));
  return { from_ms: session.ctx.asof_ms - n * DAY_MS, to_ms: session.ctx.asof_ms };
}

/** The arguments that name the same range again, for `next:` lines. */
export function rangeArgs(/** @type {Query["options"]} */ options, /** @type {{ from_ms: number, to_ms: number }} */ range) {
  if (options.from !== null && options.to !== null) return ["--from", quoteArg(options.from), "--to", quoteArg(options.to)];
  return ["--since", options.since ?? `${Math.round((range.to_ms - range.from_ms) / DAY_MS)}d`];
}

/** @param {Session} session @param {Tenant} tenant @param {string} value */
export function dateArg(session, tenant, value) {
  if (value === "today") return localDate(session.ctx.asof_ms, tenant.tz);
  if (value === "yesterday") return localDate(session.ctx.asof_ms - DAY_MS, tenant.tz);
  if (!realDate(value)) throw new UsageError(`${value} is not a date like 2026-11-18`);
  return value;
}

export const nextDate = (/** @type {string} */ date) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** @param {readonly string[]} args @param {string} what */
export function need(args, what) {
  if (args.length === 0) throw new UsageError(`say ${what}`);
  return args;
}

/** One person behind a lookup match, so a user named on two seats is one candidate. @param {Entry} entry */
export function personKey(entry) {
  const target = entry.target;
  if (target.kind !== "person") return `${entry.kind}:${entry.id}`;
  return target.person.kind === "seat" ? `seat:${target.person.participant}` : `${target.person.kind}:${target.person.id}`;
}

/** @param {Entry} entry */
export const describe = (entry) => `${entry.kind}${entry.meaning && entry.meaning !== entry.kind ? `(${entry.meaning})` : ""} ${entry.label}`;
