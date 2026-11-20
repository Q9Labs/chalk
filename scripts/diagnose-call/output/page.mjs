// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * Paging for records. `--limit` and a stable cursor are the main controls; `--budget` is optional and approximate, because token
 * counts depend on the tokenizer. Status, anchor, gaps and `next:` lines are never paged: only records are, and the page says how
 * many it left out, which is a different thing from a source that was not read completely (that is a `gap:`).
 *
 * A cursor names the sort key of the last record shown and the scope it belongs to, not an offset, so the next page stays right when
 * new records arrive in between.
 */
import { createHash } from "node:crypto";

export const DEFAULT_LIMIT = 20;

/**
 * @typedef {{ limit: number, cursor: string | null, budget: number | null }} PageOptions
 * @typedef {{ limit: number, budget: number | null, shown: number, omitted: number, by: "limit" | "budget" | null, cursor: string | null }} Page
 */

/** @param {string} scope */
const scopeTag = (scope) => createHash("sha256").update(scope).digest("hex").slice(0, 4);

/**
 * @param {string} scope
 * @param {string} key
 */
const encodeCursor = (scope, key) => `c_${scopeTag(scope)}${Buffer.from(key, "utf8").toString("base64url")}`;

/**
 * @param {string} scope
 * @param {string} cursor
 * @returns {string} the sort key to continue after
 */
function decodeCursor(scope, cursor) {
  if (!cursor.startsWith("c_") || cursor.slice(2, 6) !== scopeTag(scope)) throw new UsageError(`cursor ${cursor} belongs to another view: rerun the command without --cursor`);
  return Buffer.from(cursor.slice(6), "base64url").toString("utf8");
}

/**
 * @template {{ key: string }} R
 * @param {readonly R[]} records sorted by key
 * @param {string} scope
 * @param {PageOptions} options
 * @param {(record: Omit<R, "key">) => number} measure approximate tokens of one record as text
 * @returns {{ records: Omit<R, "key">[], page: Page }}
 */
export function page(records, scope, { limit, cursor, budget }, measure) {
  const after = cursor === null ? null : decodeCursor(scope, cursor);
  const rest = after === null ? [...records] : records.filter((record) => record.key > after);
  /** @type {R[]} */
  const shown = [];
  /** @type {Page["by"]} */
  let by = null;
  let spent = 0;
  for (const record of rest) {
    if (shown.length >= limit) {
      by = "limit";
      break;
    }
    const cost = measure(strip(record));
    if (budget !== null && shown.length > 0 && spent + cost > budget) {
      by = "budget";
      break;
    }
    spent += cost;
    shown.push(record);
  }
  const omitted = rest.length - shown.length;
  const last = shown.at(-1);
  return { records: shown.map(strip), page: { limit, budget, shown: shown.length, omitted, by, cursor: omitted > 0 && last ? encodeCursor(scope, last.key) : null } };
}

/**
 * @template {{ key: string }} R
 * @param {R} record
 * @returns {Omit<R, "key">}
 */
function strip(record) {
  const { key: _key, ...rest } = record;
  return rest;
}

/** Approximate o200k tokens of a text: about four characters a token for this grammar. Only `--budget` uses it. */
export const approxTokens = (/** @type {string} */ text) => Math.ceil(text.length / 4);

/** A mistake in how the command was called; the CLI prints it with the usage and exits 64. */
export class UsageError extends Error {}
