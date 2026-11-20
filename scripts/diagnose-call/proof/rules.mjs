// @ts-check
/**
 * What a check author can get wrong, caught when the catalogue loads or when a rule answers, with the check's code in the message.
 * The kernel trusts a catalogue that passes here and a decision that passes here; everything else about a rule's evidence is held by
 * the kernel itself (verdict.mjs: citations, coverage, independence).
 */
import { factDef } from "./facts.mjs";

/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./profile.mjs").Decision} Decision */
/** @typedef {import("./profile.mjs").Requirement} Requirement */

/** The delivery streams a watermark can prove complete (evidence.mjs `source`). */
export const SOURCES = Object.freeze(["client", "api", "sfu", "sync", "db", "recorder", "report"]);

/**
 * Query placeholders, and the item kinds and check shapes that can fill each.
 * @type {ReadonlyMap<string, (def: CheckDef) => boolean>}
 */
const PLACEHOLDERS = new Map(
  /** @type {[string, (def: CheckDef) => boolean][]} */ ([
    ["episode", (def) => def.item === "episode" || def.item === "job"],
    ["participant", (def) => def.per === "seat"],
    ["attempt", (def) => def.item === "attempt"],
    ["job", (def) => def.item === "job"],
    ["from", () => true],
    ["to", () => true],
  ]),
);

const CODE = /^[a-z][a-z0-9_]*\.[a-z0-9_.]+$/u;

/**
 * Throws on the first malformed check, naming it.
 * @param {readonly CheckDef[]} catalogue
 */
export function validateCatalogue(catalogue) {
  const codes = new Set();
  for (const def of catalogue) {
    const where = `check ${def.code}`;
    if (!CODE.test(def.code)) throw new TypeError(`${where}: a code is <area>.<symptom> in lower case, like audio.no_voice_detected`);
    if (codes.has(def.code)) throw new TypeError(`two checks share the code ${def.code}`);
    codes.add(def.code);
    if (!["episode", "attempt", "job"].includes(def.item)) throw new TypeError(`${where}: item is episode, attempt or job, not ${JSON.stringify(def.item)}`);
    if (def.per !== "item" && def.per !== "seat") throw new TypeError(`${where}: per is item or seat, not ${JSON.stringify(def.per)}`);
    if (def.per === "seat" && def.item !== "episode") throw new TypeError(`${where}: per-seat checks apply to Episodes only`);
    if (def.requires.length === 0) throw new TypeError(`${where}: requires lists at least one fact, or nothing could ever prove the check`);
    for (const requirement of [...def.requires, ...def.optional]) validateRequirement(where, def, requirement);
  }
}

/**
 * @param {string} where
 * @param {CheckDef} def
 * @param {Requirement} requirement
 */
function validateRequirement(where, def, requirement) {
  factDef(requirement.fact);
  if (requirement.from.length === 0) throw new TypeError(`${where}: ${requirement.fact} names no source`);
  for (const source of requirement.from) if (!SOURCES.includes(source)) throw new TypeError(`${where}: ${requirement.fact} names the source ${JSON.stringify(source)}; sources are ${SOURCES.join(", ")}`);
  for (const [, name] of requirement.query.matchAll(/\{([^}]*)\}/gu)) {
    const fills = PLACEHOLDERS.get(name);
    if (fills === undefined) throw new TypeError(`${where}: the ${requirement.fact} query uses {${name}}; placeholders are ${[...PLACEHOLDERS.keys()].join(", ")}`);
    if (!fills(def)) throw new TypeError(`${where}: the ${requirement.fact} query uses {${name}}, which a ${def.per === "seat" ? "per-seat" : "per-item"} ${def.item} check cannot fill`);
  }
}

const OUTCOMES = Object.freeze(["broken", "degraded", "expected"]);
const UPSTREAM = Object.freeze(["witnessed", "unknown", null]);

/**
 * Throws when a rule answers with a shape the kernel does not define. A hypothesis needs a witnessed upstream hop: without one, the
 * evidence stops at the hop, and naming a cause past it would be a guess.
 * @param {string} where
 * @param {Decision} decision
 */
export function validateDecision(where, decision) {
  const status = decision?.status;
  if (status === "pass") return;
  if (status === "unknown") {
    if (typeof decision.reason !== "string" || decision.reason === "") throw new TypeError(`${where}: an unknown decision says why in reason`);
    return;
  }
  if (status !== "finding") throw new TypeError(`${where}: decide returned status ${JSON.stringify(status)}; it returns pass, unknown or finding`);
  if (!OUTCOMES.includes(decision.outcome)) throw new TypeError(`${where}: a finding's outcome is ${OUTCOMES.join(", ")}, not ${JSON.stringify(decision.outcome)}`);
  if (!UPSTREAM.includes(decision.upstream)) throw new TypeError(`${where}: upstream is witnessed, unknown or null, not ${JSON.stringify(decision.upstream)}`);
  if (decision.hypothesis !== null && decision.upstream !== "witnessed") throw new TypeError(`${where}: a hypothesis needs a witnessed upstream hop`);
}
