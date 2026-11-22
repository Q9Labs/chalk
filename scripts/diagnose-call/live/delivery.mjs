// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * What the telemetry ledger lets the live reader take as evidence. The ledger is the delivery authority for client sources: a
 * client row is evidence only when the ledger stored its `(source_id, seq)`. No build registry exists yet, so what a source emits is
 * what its rows show at each build.
 */
import { observationsFromRows, rowSources } from "../proof/rows.mjs";

/** @typedef {import("./world.mjs").LedgerSource} LedgerSource */
/** @typedef {Readonly<Record<string, unknown>>} Row */

/** The envelope fields that name the build a row came from. */
const BUILD_FIELDS = Object.freeze(["release_sha", "app_version", "app_build", "sdk_version", "platform", "schema_ver"]);

/**
 * The facts one source's rows show at every build they came from: a fact counts as emitted only when each build was seen emitting
 * it, and no rows emit nothing. Until a build registry says what each build can emit, this is the only proof a build emits a fact.
 * @param {readonly Row[]} rows the source's rows
 * @param {string} source
 * @returns {string[]}
 */
export function observedEmits(rows, source) {
  /** @type {Map<string, Row[]>} */
  const builds = new Map();
  for (const row of rows) {
    const build = JSON.stringify(BUILD_FIELDS.map((field) => row[field] ?? null));
    builds.set(build, [...(builds.get(build) ?? []), row]);
  }
  const each = [...builds.values()].map((group) => new Set(observationsFromRows(group).observations.flatMap((o) => (o.source === source ? [o.fact] : []))));
  if (each.length === 0) return [];
  return [...each[0]].filter((fact) => each.every((facts) => facts.has(fact))).sort();
}

/** @param {LedgerSource} source @param {number} seq */
export const storedSeq = (source, seq) => (source.watermark.stored ?? []).some((range) => seq >= range.from && seq < range.to);

/**
 * The rows that may be evidence: every row no client fact reads, and a client row only when a ledger source of this Episode stored
 * its seq. The ledger is the delivery authority, so a client row it did not store (a replay, a forged or foreign source, a rejected
 * record) is never evidence.
 * @param {readonly Row[]} rows
 * @param {readonly LedgerSource[]} sources
 */
export function deliveredRows(rows, sources) {
  const byId = new Map(sources.map((source) => [source.source_id, source]));
  /** @type {Row[]} */
  const usable = [];
  let ignored = 0;
  for (const row of rows) {
    const source = rowSources(row).includes("client") ? byId.get(String(row.source_id)) : null;
    if (source === null || (source !== undefined && typeof row.seq === "number" && storedSeq(source, row.seq))) usable.push(row);
    else ignored += 1;
  }
  return { usable, ignored };
}
