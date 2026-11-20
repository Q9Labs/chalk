#!/usr/bin/env node
// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * `pnpm diagnose`: the agent's front door to verdicts. It reads stored verdicts and their status, looks things up, and runs `check`
 * on demand; nothing schedules it. `diagnose call <uuid>` is the existing single-call report over today's rows (index.mjs).
 *
 * The verdict layer reads through check.mjs's four ports over a World: a fixture world (`--fixture`), or one Episode read from the
 * real stores (`--live --tenant <uuid> --episode <uuid>`, live/stores.mjs). Every command except `call` needs one. See docs/diagnose.md.
 */
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { CATALOGUE, RULES } from "./proof/catalogue.mjs";
import { standing, statusOf } from "./proof/check.mjs";
import { openWorld } from "./proof/fixture-world.mjs";
import { StoreError, openLive, realStores } from "./live/stores.mjs";
import { renderJson } from "./output/json.mjs";
import { UsageError } from "./output/page.mjs";
import { USAGE, instant, parseQuery } from "./output/query.mjs";
import { handleKind, indexWorld, resolve } from "./output/resolve.mjs";
import { measureRecord, renderText } from "./output/text.mjs";
import { quoteArg, rangeView } from "./output/views.mjs";
import { candidates, itemsIn, tenantNamed, rangeOf, rangeArgs, dateArg, need, personKey, describe } from "./scope.mjs";
import { symptomCode, openItem, openEntry, runCheck, day, openDay } from "./commands.mjs";

/** @typedef {import("./output/views.mjs").View} View */
/** @typedef {import("./output/views.mjs").ViewContext} ViewContext */
/** @typedef {import("./output/views.mjs").Tenant} Tenant */
/** @typedef {import("./output/resolve.mjs").Entry} Entry */
/** @typedef {import("./output/query.mjs").Query} Query */
/** @typedef {import("./proof/check.mjs").Item} Item */
/** @typedef {import("./proof/check.mjs").Status} Status */
/** @typedef {import("./proof/fixture-world.mjs").World} World */
/** @typedef {{ catalogue: readonly import("./proof/profile.mjs").CheckDef[], rules: string }} Checks */

const DISCOVERY_COMMANDS = new Set(["attempt", "job", "day", "space", "tenant", "platform", "pattern", "window"]);
const FIXTURES = { nov18: new URL("./fixtures/nov18.mjs", import.meta.url).href };
/**
 * Runs one command and returns its output instead of printing it, so tests call it directly.
 * @param {readonly string[]} argv
 * @param {{ cwd?: string, stores?: import("./live/stores.mjs").Stores, now?: number, checks?: Checks }} [options] `stores` and `now`
 *   replace the real stores and clock behind `--live`, for tests; `checks` replaces the catalogue, so the CLI contract goldens judge
 *   only the foundation's checks
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
export async function run(argv, { cwd = process.cwd(), stores, now, checks = { catalogue: CATALOGUE, rules: RULES } } = {}) {
  if (argv[0] === "call") {
    const { main } = await import("./index.mjs");
    return { code: await main([...argv.slice(1)]), out: "", err: "" };
  }
  try {
    const { live, rest } = liveTarget(argv);
    const query = parseQuery(rest);
    if (live !== null && query.options.fixture !== null) throw new UsageError("pass --live or --fixture, not both");
    if (live === null && query.options.fixture === null) {
      return { code: 69, out: "", err: "diagnose: the verdict commands need a world; pass --fixture nov18, --live --tenant <uuid> --episode <uuid>, or run `diagnose call <episode uuid>` for the single-call report\n" };
    }
    if (live !== null && DISCOVERY_COMMANDS.has(query.command)) {
      throw new UsageError("--live reads one Episode; use --fixture <world> for attempts, jobs or population views");
    }
    const opened = live === null ? { world: await fixtureWorld(query, cwd), notes: [] } : await openLive(live, stores ?? realStores(process.env), { catalogue: checks.catalogue, now });
    const session = await open(query, cwd, opened.world, checks);
    const dispatched = await dispatch(query, session);
    // A live read without --store keeps nothing, so its head says so and no line claims a verdict retained from an earlier run.
    const fresh = live !== null && query.options.store === null;
    const selector = worldSelector(live, query.options);
    const view = { ...dispatched, head: fresh ? { ...dispatched.head, read: /** @type {const} */ ("fresh") } : dispatched.head, next: dispatched.next.map((command) => `${command} ${selector}`) };
    const notes = [...opened.notes, ...(fresh ? ["fresh read: without --store nothing is retained across runs, so no verdict here rests on history"] : [])];
    return { code: exitCode(view, query), out: query.options.json ? renderJson(view) : renderText(view), err: notes.map((note) => `diagnose: live: ${note}\n`).join("") };
  } catch (error) {
    if (error instanceof UsageError) return { code: 64, out: "", err: `diagnose: ${error.message}\n${USAGE}\n` };
    if (error instanceof SourceError || error instanceof StoreError) return { code: 69, out: "", err: `diagnose: ${error.message}\n` };
    throw error;
  }
}

/**
 * Takes `--live`, and with it `--tenant <uuid>` and `--episode <uuid>`, out of argv: in live mode the tenant names the store to read,
 * not a lookup scope. The query parser sees the rest.
 * @param {readonly string[]} argv
 * @returns {{ live: { tenant: string, episode: string } | null, rest: string[] }}
 */
function liveTarget(argv) {
  if (!argv.includes("--live")) return { live: null, rest: [...argv] };
  /** @type {string[]} */
  const rest = [];
  /** @type {Record<string, string>} */
  const target = {};
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index].split(/=(.*)/su);
    if (name === "--live") continue;
    if (name === "--tenant" || name === "--episode") {
      const value = inline ?? argv[(index += 1)];
      if (value === undefined || value === "") throw new UsageError(`${name} needs a value`);
      target[name.slice(2)] = value;
    } else rest.push(argv[index]);
  }
  if (target.tenant === undefined || target.episode === undefined) throw new UsageError("--live needs --tenant <uuid> and --episode <uuid>");
  return { live: { tenant: target.tenant, episode: target.episode }, rest };
}

/**
 * The flags that name the world a view came from, so every printed `next:` command runs as printed against the same world.
 * @param {{ tenant: string, episode: string } | null} live
 * @param {Query["options"]} options
 */
function worldSelector(live, options) {
  const world = live === null ? ["--fixture", quoteArg(String(options.fixture))] : ["--live", "--tenant", live.tenant, "--episode", live.episode];
  for (const [flag, value] of /** @type {const} */ ([
    ["--store", options.store],
    ["--asof", options.asof],
  ]))
    if (value !== null) world.push(flag, quoteArg(value));
  return world.join(" ");
}

/** A data source the command needs is missing: exit 69. */
class SourceError extends Error {}

/**
 * 0 by default. With --strict: 3 when something is broken or degraded, 0 only when the outcome is healthy or expected over complete
 * coverage, and 2 otherwise (an unknown outcome, coverage that is not complete, or a lookup that did not resolve).
 */
function exitCode(/** @type {View} */ view, /** @type {Query} */ query) {
  if (!query.options.strict) return 0;
  if (view.view === "resolve") return 2;
  const { outcome, coverage } = view.head;
  if (outcome === "broken" || outcome === "degraded") return 3;
  return (outcome === "healthy" || outcome === "expected") && coverage?.state === "complete" ? 0 : 2;
}

/**
 * @param {Query} query
 * @param {string} cwd
 * @returns {Promise<World>}
 */
async function fixtureWorld(query, cwd) {
  const fixture = query.options.fixture ?? "";
  const named = new Map(Object.entries(FIXTURES)).get(fixture);
  const path = resolvePath(cwd, fixture);
  if (named === undefined && !existsSync(path)) throw new SourceError(`no fixture world at ${path}; pass --fixture nov18 or a world module`);
  const module = await import(named ?? pathToFileURL(path).href);
  return typeof module.default === "function" ? module.default() : module.default;
}

/**
 * @param {Query} query
 * @param {string} cwd
 * @param {World} world
 * @param {Checks} checks
 */
async function open(query, cwd, world, { catalogue, rules }) {
  const store = query.options.store === null ? null : resolvePath(cwd, query.options.store);
  if (store !== null && !existsSync(dirname(store))) throw new UsageError(`--store ${store}: its directory does not exist`);
  const { items, ports } = await openWorld(world, { catalogue, rules, store });
  const asof_ms =
    query.options.asof === null
      ? world.asof_ms
      : instant(query.options.asof, () => {
          throw new UsageError("--asof is an instant with a zone, like 2026-11-19T01:00Z");
        });
  /** @type {ViewContext} */
  const ctx = { asof_ms, rules, catalogue, paging: { limit: query.options.limit, cursor: query.options.cursor, budget: query.options.budget }, measure: measureRecord };
  const statuses = new Map(await Promise.all(items.map(async (item) => /** @type {const} */ ([item, await statusOf(item, ports, rules)]))));
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
    const direct = handleKind(text) === found[0].kind && found[0].target.kind !== "person";
    return openEntry(session, found[0], query, direct ? null : { query: text, as: describe(found[0]) });
  },
  day: (query, session) => {
    const tenant = tenantNamed(session, need(query.args, "a tenant")[0]);
    return day(session, tenant, dateArg(session, tenant, query.args[1] ?? "today"), query.options.symptom === null ? null : symptomCode(session, query.options.symptom));
  },
  episode: openItem("episode"),
  attempt: openItem("attempt"),
  job: openItem("job"),
  space: openDay("space"),
  tenant: openDay("tenant"),
  platform: openDay("platform"),
  evidence: (query, session, tenantScope) => {
    const text = need(query.args, "a finding").join(" ");
    const found = resolve(session.entries, text, { tenant: tenantScope?.id ?? null, kinds: ["finding"] });
    return found.length === 1 ? openEntry(session, found[0], query, null) : candidates(session, text, found);
  },
  participant: (query, session, tenantScope) => {
    const text = need(query.args, "a person").join(" ");
    rangeOf(session, query.options, tenantScope?.tz ?? "UTC", 30);
    const found = resolve(session.entries, text, { tenant: tenantScope?.id ?? null, kinds: ["user", "agent", "participant"] });
    const people = [...new Map(found.map((entry) => [personKey(entry), entry])).values()];
    if (people.length !== 1) return candidates(session, text, people, query.options);
    const viaSeat = people[0].kind === "participant" && found.length === 1 && people[0].meaning !== "guest";
    return openEntry(session, people[0], query, viaSeat ? { query: text, as: describe(people[0]) } : null);
  },
  pattern: (query, session, tenantScope) => {
    const { args, options } = query;
    const code = symptomCode(session, need(args, "a symptom code")[0]);
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
    const symptom = options.symptom === null ? null : symptomCode(session, options.symptom);
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

if (import.meta.main) {
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
