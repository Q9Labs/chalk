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
 * @typedef {"once" | "state" | "aggregate" | "event"} FactKind
 */

/** @type {Readonly<Record<string, FactKind>>} */
export const FACTS = Object.freeze({
  "audio.mic_state": "state",
  "audio.ingress": "aggregate",
  "audio.capture": "aggregate",
  "board.camera": "event",
  "episode.end": "once",
  "client.leave": "event",
  "entry.decision": "once",
  "job.terminal": "once",
  "report.problem": "event",
});

/**
 * @param {string} fact
 * @returns {FactKind}
 */
export function factKind(fact) {
  const kind = FACTS[fact];
  if (kind === undefined) throw new TypeError(`unknown fact ${JSON.stringify(fact)}: add it to scripts/diagnose-call/proof/facts.mjs`);
  return kind;
}
