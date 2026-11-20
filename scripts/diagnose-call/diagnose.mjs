#!/usr/bin/env node
// @ts-check
/**
 * `pnpm diagnose`: the agent's front door to verdicts. It reads stored verdicts and their status, looks things up, and runs `check`
 * on demand; nothing schedules it. `diagnose call <uuid>` is the existing single-call report over today's rows (index.mjs).
 *
 * The verdict layer reads through check.mjs's four ports. Until the slices wire live adapters (C1's envelope, C3's watermarks),
 * only a fixture world implements them, so every command except `call` needs `--fixture`. See docs/diagnose.md.
 */
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { CATALOGUE, RULES } from "./proof/catalogue.mjs";
import { check, standing, statusOf } from "./proof/check.mjs";
import { openWorld } from "./proof/fixture-world.mjs";
import { localDate, localMidnight, ref } from "./output/format.mjs";
import { renderJson } from "./output/json.mjs";
import { UsageError } from "./output/page.mjs";
import { USAGE, instant, parseQuery } from "./output/query.mjs";
import { parseHandle } from "./output/handle.mjs";
import { indexWorld, resolve } from "./output/resolve.mjs";
import { measureRecord, renderText } from "./output/text.mjs";
import { checkView, dayView, evidenceView, itemView, quoteArg, rangeView, refKind, resolveView } from "./output/views.mjs";

/** @typedef {import("./output/views.mjs").View} View */
/** @typedef {import("./output/views.mjs").ViewContext} ViewContext */
/** @typedef {import("./output/views.mjs").Tenant} Tenant */
/** @typedef {import("./output/resolve.mjs").Entry} Entry */
/** @typedef {import("./output/query.mjs").Query} Query */
/** @typedef {import("./proof/check.mjs").Item} Item */
/** @typedef {import("./proof/check.mjs").Status} Status */
/** @typedef {import("./proof/fixture-world.mjs").World} World */

const FIXTURES = { nov18: new URL("./fixtures/nov18.mjs", import.meta.url).href };
const DAY_MS = 86_400_000;
const BACKSTOPS = ["UNEXPLAINED", "BLIND_SPOT"];

/**
 * Runs one command and returns its output instead of printing it, so tests call it directly.
 * @param {readonly string[]} argv
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
export async function run(argv, { cwd = process.cwd() } = {}) {
  if (argv[0] === "call") {
    const { main } = await import("./index.mjs");
    return { code: await main([...argv.slice(1)]), out: "", err: "" };
  }
  try {
    const query = parseQuery(argv);
    if (query.options.fixture === null) {
      return { code: 69, out: "", err: "diagnose: the verdict commands read a fixture world until the slices wire live adapters; pass --fixture nov18, or run `diagnose call <episode uuid>` for today's real-data report\n" };
    }
    const session = await open(query, cwd);
    const view = await dispatch(query, session);
    return { code: exitCode(view, query), out: query.options.json ? renderJson(view) : renderText(view), err: "" };
  } catch (error) {
    if (error instanceof UsageError) return { code: 64, out: "", err: `diagnose: ${error.message}\n${USAGE}\n` };
    throw error;
  }
}

/** 0 by default. With --strict: 3 when something is broken or degraded, 2 when coverage is not complete or a lookup did not resolve. */
function exitCode(/** @type {View} */ view, /** @type {Query} */ query) {
  if (!query.options.strict) return 0;
  if (view.view === "resolve") return 2;
  if (view.head.outcome === "broken" || view.head.outcome === "degraded") return 3;
  return view.head.coverage?.state === "complete" ? 0 : 2;
}

/**
 * @param {Query} query
 * @param {string} cwd
 */
async function open(query, cwd) {
  const fixture = /** @type {string} */ (query.options.fixture);
  const url = fixture in FIXTURES ? FIXTURES[/** @type {keyof typeof FIXTURES} */ (fixture)] : pathToFileURL(resolvePath(cwd, fixture)).href;
  const module = await import(url);
  /** @type {World} */
  const world = typeof module.default === "function" ? module.default() : module.default;
  const store = query.options.store === null ? null : resolvePath(cwd, query.options.store);
  const { items, ports } = await openWorld(world, { catalogue: CATALOGUE, rules: RULES, store });
  const asof_ms = query.options.asof === null ? world.asof_ms : instant(query.options.asof, () => Number.NaN);
  /** @type {ViewContext} */
  const ctx = { asof_ms, rules: RULES, catalogue: CATALOGUE, paging: { limit: query.options.limit, cursor: query.options.cursor, budget: query.options.budget }, measure: measureRecord };
  const statuses = new Map(await Promise.all(items.map(async (item) => /** @type {const} */ ([item, await statusOf(item, ports, RULES)]))));
  const entries = indexWorld(
    world,
    items,
    items.map((item) => ({ item, verdict: standing(/** @type {Status} */ (statuses.get(item))).verdict })),
  );
  return { world, items, ports, ctx, statuses, entries };
}

/** @typedef {Awaited<ReturnType<typeof open>>} Session */

/**
 * @param {Query} query
 * @param {Session} session
 * @returns {Promise<View>}
 */
async function dispatch(query, session) {
  const handler = Object.hasOwn(COMMANDS, query.command) ? COMMANDS[query.command] : null;
  if (handler === null) throw new UsageError(`unknown command ${query.command}`);
  const tenantScope = query.options.tenant === null ? null : tenantNamed(session, query.options.tenant);
  return handler(query, session, tenantScope);
}

/** @typedef {(query: Query, session: Session, tenantScope: Tenant | null) => View | Promise<View>} Command */

/**
 * One handler per command. A handler resolves its arguments against the index and opens one view, or returns candidates when the
 * lookup is ambiguous; it never picks among several matches.
 * @type {Record<string, Command>}
 */
const COMMANDS = {
  resolve: (query, session, tenantScope) => {
    const text = need(query.args, "what to look up").join(" ");
    const found = resolve(session.entries, text, { tenant: tenantScope?.id ?? null });
    if (found.length !== 1) return candidates(session, text, found);
    const direct = parseHandle(text)?.kind === found[0].kind && found[0].target.kind !== "person";
    return openEntry(session, found[0], query, direct ? null : { query: text, as: describe(found[0]) });
  },
  day: (query, session) => {
    const tenant = tenantNamed(session, need(query.args, "a tenant")[0]);
    return day(session, tenant, dateArg(session, tenant, query.args[1] ?? "today"), query.options.symptom);
  },
  episode: openItem("episode"),
  attempt: openItem("attempt"),
  job: openItem("job"),
  evidence: (query, session, tenantScope) => {
    const text = need(query.args, "a finding").join(" ");
    const found = resolve(session.entries, text, { tenant: tenantScope?.id ?? null, kinds: ["finding"] });
    return found.length === 1 ? openEntry(session, found[0], query, null) : candidates(session, text, found);
  },
  participant: (query, session, tenantScope) => {
    const text = need(query.args, "a person").join(" ");
    const found = resolve(session.entries, text, { tenant: tenantScope?.id ?? null, kinds: ["user", "agent", "participant"] });
    const people = [...new Map(found.map((entry) => [personKey(entry), entry])).values()];
    if (people.length !== 1) return candidates(session, text, people);
    const viaSeat = people[0].kind === "participant" && found.length === 1 && people[0].meaning !== "guest";
    return openEntry(session, people[0], query, viaSeat ? { query: text, as: describe(people[0]) } : null);
  },
  pattern: (query, session, tenantScope) => {
    const { args, options } = query;
    const code = need(args, "a symptom code")[0];
    const known = [...CATALOGUE.map((def) => def.code), ...BACKSTOPS];
    if (!known.includes(code)) throw new UsageError(`unknown symptom ${code}; known: ${known.join(", ")}`);
    const tz = tenantScope?.tz ?? "UTC";
    const range = rangeOf(session, options, tz, 30);
    const entries = itemsIn(session, tenantScope?.id ?? null, range);
    const scopeArgs = [...(tenantScope ? ["--tenant", tenantScope.name] : []), ...rangeArgs(options, range)];
    return rangeView({ title: { view: "pattern", scope: { code, ...(tenantScope ? { tenant: tenantScope.name } : {}) } }, tenantTz: tz, range, entries, keep: (finding) => finding.code === code, check: scopeArgs, again: ["pattern", code, ...scopeArgs], ctx: session.ctx });
  },
  window: (query, session) => {
    const { args, options } = query;
    const tenant = tenantNamed(session, need(args, "a tenant")[0]);
    if (options.from === null || options.to === null) throw new UsageError("window needs --from and --to");
    const range = rangeOf(session, options, tenant.tz, 0);
    const entries = itemsIn(session, tenant.id, range);
    const symptom = options.symptom;
    const scopeArgs = ["--from", options.from, "--to", options.to, ...(symptom ? ["--symptom", symptom] : [])];
    return rangeView({
      title: { view: "window", scope: { tenant: tenant.name, ...(symptom ? { symptom } : {}) } },
      tenantTz: tenant.tz,
      range,
      entries,
      keep: (finding) => symptom === null || finding.code === symptom,
      check: [tenant.name, "--from", options.from, "--to", options.to],
      again: ["window", tenant.name, ...scopeArgs],
      ctx: session.ctx,
    });
  },
  check: (query, session, tenantScope) => runCheck(session, query, tenantScope),
};

/**
 * `episode`, `attempt` and `job` open one item of that kind; a finding or session id that names the item resolves to it, and says so.
 * @param {"episode" | "attempt" | "job"} command
 * @returns {Command}
 */
function openItem(command) {
  return (query, session, tenantScope) => {
    const text = need(query.args, `the ${command}`).join(" ");
    const found = resolve(session.entries, text, { tenant: tenantScope?.id ?? null }).flatMap((entry) => ((entry.target.kind === "item" || entry.target.kind === "finding") && entry.target.item.kind === command ? [{ entry, item: entry.target.item }] : []));
    const matches = [...new Map(found.map((match) => [match.item.id, match])).values()];
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
function openEntry(session, entry, query, via) {
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
  const who = person.kind === "seat" ? { ref: ref("participant", person.participant), name: entry.name } : { ref: ref(person.kind, person.id), name: entry.kind === "participant" ? null : entry.label };
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
async function runCheck(session, query, tenantScope) {
  const { args, options } = query;
  /** @type {import("./proof/check.mjs").Scope} */
  let scope;
  /** @type {Record<string, unknown>} */
  let shown;
  let tz = tenantScope?.tz ?? "UTC";
  const tenantArg = args.length > 0 ? resolve(session.entries, args[0], { kinds: ["tenant"] }) : [];
  if (args.length > 0 && tenantArg.length === 0) {
    const text = args.join(" ");
    const found = resolve(session.entries, text, { tenant: tenantScope?.id ?? null }).filter((entry) => entry.target.kind === "item" || entry.target.kind === "finding");
    const items = [...new Map(found.map((entry) => [/** @type {{ item: Item }} */ (entry.target).item.id, entry])).values()];
    if (items.length !== 1) return candidates(session, text, items);
    const item = /** @type {{ item: Item }} */ (items[0].target).item;
    scope = { item: { kind: item.kind, id: item.id } };
    shown = { item: ref(refKind(item.kind), item.id) };
    tz = tenantOf(session, item.tenant).tz;
  } else {
    const tenant = tenantArg.length === 1 ? tenantOf(session, tenantArg[0].id) : tenantScope;
    tz = tenant?.tz ?? "UTC";
    if (args[1] !== undefined && tenant) {
      const date = dateArg(session, tenant, args[1]);
      scope = { tenant: tenant.id, from_ms: localMidnight(date, tenant.tz), to_ms: localMidnight(nextDate(date), tenant.tz) };
      shown = { tenant: tenant.name, date };
    } else {
      const range = rangeOf(session, options, tz, 1);
      scope = { tenant: tenant?.id ?? null, ...range };
      shown = { tenant: tenant?.name ?? "all", since: options.since ?? (options.from ? `${options.from}..${options.to}` : "1d") };
    }
  }
  const results = await check(scope, session.ports, { catalogue: CATALOGUE, rules: RULES, asof_ms: session.ctx.asof_ms });
  return checkView({ scope: shown, tz, results, ctx: session.ctx });
}

/** @param {Session} session @param {Tenant} tenant @param {string} date @param {string | null} symptom */
function day(session, tenant, date, symptom) {
  const range = { from_ms: localMidnight(date, tenant.tz), to_ms: localMidnight(nextDate(date), tenant.tz) };
  return dayView({ tenant, date, entries: itemsIn(session, tenant.id, range), ctx: session.ctx, symptom });
}

/** @param {Session} session @param {string} query @param {readonly Entry[]} found */
function candidates(session, query, found) {
  return resolveView({ query, candidates: found, ctx: session.ctx, tz: "UTC" });
}

/** Items of a tenant (or every tenant) that started inside a range, with their status. */
function itemsIn(/** @type {Session} */ session, /** @type {string | null} */ tenant, /** @type {{ from_ms: number, to_ms: number }} */ range) {
  return session.items.filter((item) => (tenant === null || item.tenant === tenant) && item.declaration.window.from_ms >= range.from_ms && item.declaration.window.from_ms < range.to_ms).map((item) => ({ item, status: statusFor(session, item) }));
}

/** @param {Session} session @param {Item} item @returns {Status} */
const statusFor = (session, item) => /** @type {Status} */ (session.statuses.get(item));

/** @param {Session} session @param {string} id @returns {Tenant} */
function tenantOf(session, id) {
  const tenant = session.world.tenants.find((candidate) => candidate.id === id);
  if (!tenant) throw new TypeError(`no tenant ${id} in the world`);
  return tenant;
}

/** @param {Session} session @param {string} text @returns {Tenant} */
function tenantNamed(session, text) {
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
function rangeOf(session, options, tz, days) {
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
function rangeArgs(/** @type {Query["options"]} */ options, /** @type {{ from_ms: number, to_ms: number }} */ range) {
  if (options.from !== null && options.to !== null) return ["--from", quoteArg(options.from), "--to", quoteArg(options.to)];
  return ["--since", options.since ?? `${Math.round((range.to_ms - range.from_ms) / DAY_MS)}d`];
}

/** @param {Session} session @param {Tenant} tenant @param {string} value */
function dateArg(session, tenant, value) {
  if (value === "today") return localDate(session.ctx.asof_ms, tenant.tz);
  if (value === "yesterday") return localDate(session.ctx.asof_ms - DAY_MS, tenant.tz);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new UsageError(`${value} is not a date like 2026-11-18`);
  return value;
}

const nextDate = (/** @type {string} */ date) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** @param {readonly string[]} args @param {string} what */
function need(args, what) {
  if (args.length === 0) throw new UsageError(`say ${what}`);
  return args;
}

/** One person behind a lookup match, so a user named on two seats is one candidate. @param {Entry} entry */
function personKey(entry) {
  const target = entry.target;
  if (target.kind !== "person") return `${entry.kind}:${entry.id}`;
  return target.person.kind === "seat" ? `seat:${target.person.participant}` : `${target.person.kind}:${target.person.id}`;
}

/** @param {Entry} entry */
const describe = (entry) => `${entry.kind}${entry.meaning && entry.meaning !== entry.kind ? `(${entry.meaning})` : ""} ${entry.label}`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2)).then(
    ({ code, out, err }) => {
      process.stdout.write(out);
      process.stderr.write(err);
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exitCode = 1;
    },
  );
}
