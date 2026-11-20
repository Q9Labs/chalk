// @ts-check
/**
 * The facts a witness can claim, and how two claims about one fact are compared. The table is generated: each area file in
 * observability/registry declares its facts, and `pnpm run regen` writes them into observability/generated/registry.json, which
 * this module reads. A slice adds a fact there, never here.
 *
 * - `once`: one value per subject for its whole life (an Episode's end reason). Any two different claims disagree.
 * - `state`: the claim held for the whole window (the microphone was unmuted from..to). Overlapping windows with different claims disagree.
 * - `aggregate`: a summary over exactly its window (a 15 s rollup). Only identical windows are compared; a check compares across
 *   windows itself. An aggregate counts only when its source covers its window, because an unread rollup could change the sum.
 * - `event`: a point record that may repeat (a failure, a problem report). Never compared generically.
 *
 * Every kind except `aggregate` is final once it exists: a recorded decision stays recorded however late the rest of the source is.
 *
 * `per` says who a claim is about. A `seat` fact is about one Participant, so a row of it that names no seat or connection counts for
 * nobody and is unbound, never read as item-wide. An `item` fact is about the item itself (the Episode, attempt, job, Space, Tenant or
 * platform day), and a seat's check may read it, because the seat lives inside the item. A report may come from a seat or from
 * outside the call, so `report.problem` is `any`.
 *
 * @typedef {"once" | "state" | "aggregate" | "event"} FactKind
 * @typedef {"seat" | "item" | "any"} FactPer
 * @typedef {{ event: string, source: string, claim: string, failure_claims: readonly string[], fields: readonly string[] }} FactEvent
 * @typedef {{ kind: FactKind, per: FactPer, events: readonly FactEvent[] }} FactDef
 */
import { readFileSync } from "node:fs";

const registry = JSON.parse(readFileSync(new URL("../../../observability/generated/registry.json", import.meta.url), "utf8"));

/** The witness sources, and whether each is delivered per seat. */
export const SOURCE_TABLE = Object.freeze(registry.sources.map((/** @type {{ source: string, per_seat: boolean }} */ entry) => Object.freeze({ ...entry })));
/** The item kinds a check can judge. */
export const ITEM_KINDS = Object.freeze([...registry.items]);
/** The fault components a finding's module names, and the names that stand alone. */
export const FAULT_COMPONENTS = Object.freeze({ components: Object.freeze([...registry.fault_components.components]), standalone: Object.freeze([...registry.fault_components.standalone]) });
/** Registry reason codes and their outcome, so an expected finding names a real expected reason. */
export const REASONS = Object.freeze(Object.fromEntries(registry.reasons.map((/** @type {{ code: string, outcome: string }} */ reason) => [reason.code, reason.outcome])));

/** @type {Readonly<Record<string, FactDef>>} */
export const FACTS = Object.freeze(Object.fromEntries(registry.facts.map((/** @type {{ name: string } & FactDef} */ fact) => [fact.name, Object.freeze({ kind: fact.kind, per: fact.per, events: fact.events })])));

/**
 * @param {string} fact
 * @returns {FactDef}
 */
export function factDef(fact) {
  const def = Object.hasOwn(FACTS, fact) ? FACTS[fact] : undefined;
  if (def === undefined) throw new TypeError(`unknown fact ${JSON.stringify(fact)}: declare it under an area's facts in observability/registry and run pnpm run regen`);
  return def;
}

/**
 * @param {string} fact
 * @returns {FactKind}
 */
export const factKind = (fact) => factDef(fact).kind;
