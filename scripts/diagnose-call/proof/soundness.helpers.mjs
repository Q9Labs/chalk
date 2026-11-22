// @ts-check
// The judging helpers and base items the soundness tests share.
import assert from "node:assert/strict";
import { openBundle } from "./bundle.mjs";
import { CATALOGUE, RULES } from "./catalogue.mjs";
import { SOURCE_TABLE } from "./facts.mjs";
import { ITEM, profileFor } from "./profile.mjs";
import { judge, rulesVersion } from "./verdict.mjs";
import { ASOF, IDS, nov18 } from "../fixtures/nov18.mjs";

/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./profile.mjs").Declaration} Declaration */
/** @typedef {import("./soundness.test.mjs").Evidence} Evidence */
/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./verdict.mjs").Verdict} Verdict */

/**
 * @param {Declaration} declaration
 * @param {Evidence} evidence
 * @param {{ prior?: Verdict | null, catalogue?: readonly CheckDef[], asof?: number }} [options]
 */
export function verdictOf(declaration, evidence, { prior = null, catalogue = CATALOGUE, asof = ASOF } = {}) {
  const bundle = openBundle(profileFor(declaration, catalogue, asof), { asof_ms: asof });
  for (const o of evidence.observations) bundle.add(o);
  for (const w of evidence.watermarks) bundle.watermark(w);
  return judge(bundle.seal(), catalogue, { rules: catalogue === CATALOGUE ? RULES : rulesVersion(catalogue, []), prior });
}

/** @param {string} id */
export function base(id) {
  const world = nov18();
  const declaration = /** @type {Declaration} */ (world.declarations.find((candidate) => candidate.id === id));
  return { declaration, evidence: /** @type {Evidence} */ (structuredClone(world.evidence[id])) };
}

/**
 * The source and subject of every watermark a planned check requires: a per-seat source for the seat it judges, any other for the
 * whole item. Losing a watermark no check requires may leave the item healthy.
 * @param {Declaration} declaration
 */
export function requiredWatermarks(declaration) {
  const perSeat = new Set(SOURCE_TABLE.filter((entry) => entry.per_seat).map((entry) => entry.source));
  const defs = new Map(CATALOGUE.map((def) => [def.code, def]));
  return new Set(profileFor(declaration, CATALOGUE, ASOF).checks.flatMap((planned) => (defs.get(planned.code)?.requires ?? []).flatMap((requirement) => requirement.from.map((source) => `${source}/${perSeat.has(source) ? planned.subject : ITEM}`))));
}

export const HEALTHY = [IDS.ep5c0d, IDS.ep7a21];

export const BASES = [...HEALTHY, IDS.ep9feb, IDS.ep2d4e, IDS.attempt, IDS.job];

/** The watermark that proves an observation's source for its subject. @param {Evidence} evidence @param {Observation} o */
export function watermarkFor(evidence, o) {
  const seat = o.subject.participant ? `pt:${o.subject.participant}` : null;
  return evidence.watermarks.find((w) => w.source === o.source && (w.subject === seat || w.subject === "*"));
}

/** @param {Verdict} verdict @param {string} why */
export function notHealthy(verdict, why) {
  assert.notEqual(verdict.outcome, "healthy", `${why}: the verdict must not be healthy`);
}
