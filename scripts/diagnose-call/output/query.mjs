// @ts-check
/**
 * The argument grammar of `diagnose`. Parsing only: it turns argv into a command and checked options, and leaves lookups to the
 * caller. Any mistake is a UsageError, which the CLI prints with the usage and exits 64.
 */
import { DEFAULT_LIMIT, UsageError } from "./page.mjs";

export const USAGE = `usage: diagnose <anything> | <command> [args] [options]
  <anything>                       any handle (ep_9feb, pt_4c1e, f_71c2, ev_a1f3, cs_3e4f), raw id, session id, tenant or person name
  day <tenant> [date|today|yesterday] [--symptom <code>]
  episode|attempt|job <ref>
  evidence <finding>               why the proof is sufficient: expected, observed, watermarks, queries, what would falsify it
  participant <person> [--tenant T] [--since 30d | --from D --to D]
  pattern <code> [--tenant T] [--since 30d | --from D --to D]
  window <tenant> --from <instant> --to <instant> [--symptom <code>]
  check [<ref> | <tenant> [date] | --tenant T] [--since 30d]
  call <episode uuid> [--fixture rows.json] [--strict]   the existing single-call report over today's rows
options: --json --strict --limit N (default ${DEFAULT_LIMIT}) --cursor C --budget TOKENS --fixture <world module> --store <file> --asof <instant>`;

const COMMANDS = new Set(["day", "episode", "attempt", "job", "evidence", "participant", "pattern", "window", "check", "resolve", "call"]);
const FLAGS = new Set(["json", "strict"]);
const VALUES = new Set(["limit", "cursor", "budget", "fixture", "store", "asof", "tenant", "since", "from", "to", "symptom"]);

/**
 * @typedef {{
 *   json: boolean, strict: boolean, limit: number, cursor: string | null, budget: number | null, fixture: string | null, store: string | null,
 *   asof: string | null, tenant: string | null, since: string | null, from: string | null, to: string | null, symptom: string | null,
 * }} Options
 * @typedef {{ command: string, args: string[], options: Options }} Query
 */

/**
 * @param {readonly string[]} argv
 * @returns {Query}
 */
export function parseQuery(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string | boolean>} */
  const raw = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/su);
    if (FLAGS.has(name)) raw[name] = true;
    else if (VALUES.has(name)) {
      const value = inline ?? argv[(index += 1)];
      if (value === undefined || value === "") throw new UsageError(`--${name} needs a value`);
      raw[name] = value;
    } else throw new UsageError(`unknown option --${name}`);
  }
  if (positional.length === 0) throw new UsageError("say what to diagnose");
  const command = COMMANDS.has(positional[0]) ? positional[0] : "resolve";
  const args = command === "resolve" && positional[0] !== "resolve" ? positional : positional.slice(1);
  const number = (/** @type {string} */ name, /** @type {number | null} */ fallback) => {
    const value = raw[name];
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`--${name} must be a whole number above 0`);
    return parsed;
  };
  const text = (/** @type {string} */ name) => (typeof raw[name] === "string" ? String(raw[name]) : null);
  if (raw.since !== undefined && (raw.from !== undefined || raw.to !== undefined)) throw new UsageError("use --since or --from/--to, not both");
  if (text("since") !== null && !/^\d+d$/u.test(String(text("since")))) throw new UsageError("--since takes days, like 30d");
  return {
    command,
    args,
    options: {
      json: raw.json === true,
      strict: raw.strict === true,
      limit: /** @type {number} */ (number("limit", DEFAULT_LIMIT)),
      cursor: text("cursor"),
      budget: number("budget", null),
      fixture: text("fixture"),
      store: text("store"),
      asof: text("asof"),
      tenant: text("tenant"),
      since: text("since"),
      from: text("from"),
      to: text("to"),
      symptom: text("symptom"),
    },
  };
}

/**
 * The instant a `--from`/`--to` value names: an ISO instant as given, or a bare date at the tenant's local midnight.
 * @param {string} value
 * @param {(date: string) => number} midnight
 */
export function instant(value, midnight) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return midnight(value);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || !/[zZ]|[+-]\d\d:?\d\d$/u.test(value)) throw new UsageError(`${value} is not a date (2026-11-18) or an instant with a zone (2026-11-18T09:45Z)`);
  return ms;
}
