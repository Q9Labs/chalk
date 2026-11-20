// @ts-check
/**
 * The facts a witness can claim, and how two claims about one fact are compared. A slice adds a row here for every fact its
 * adapter emits as an observation. When the C1 registry generates this table, this file becomes its output and keeps this shape.
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
 * nobody and is unbound, never read as item-wide. An `item` fact is about the Episode, attempt or job. A report may come from a seat
 * or from outside the call, so `report.problem` is `any`.
 *
 * @typedef {"once" | "state" | "aggregate" | "event"} FactKind
 * @typedef {"seat" | "item" | "any"} FactPer
 * @typedef {{ kind: FactKind, per: FactPer }} FactDef
 */

/** @type {Readonly<Record<string, FactDef>>} */
export const FACTS = Object.freeze({
  "audio.mic_state": { kind: "state", per: "seat" },
  "audio.ingress": { kind: "aggregate", per: "seat" },
  "audio.capture": { kind: "aggregate", per: "seat" },
  "board.camera": { kind: "event", per: "seat" },
  "client.leave": { kind: "event", per: "seat" },
  "episode.end": { kind: "once", per: "item" },
  "entry.decision": { kind: "once", per: "item" },
  "job.terminal": { kind: "once", per: "item" },
  "report.problem": { kind: "event", per: "any" },
});

/**
 * @param {string} fact
 * @returns {FactDef}
 */
export function factDef(fact) {
  const def = Object.hasOwn(FACTS, fact) ? FACTS[fact] : undefined;
  if (def === undefined) throw new TypeError(`unknown fact ${JSON.stringify(fact)}: add it to scripts/diagnose-call/proof/facts.mjs`);
  return def;
}

/**
 * @param {string} fact
 * @returns {FactKind}
 */
export const factKind = (fact) => factDef(fact).kind;
