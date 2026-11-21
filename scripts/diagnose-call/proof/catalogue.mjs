// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * The checks, assembled from their one home. A symptom's code, item, per and witnesses live in its area file under
 * observability/registry (generated into observability/generated/registry.json); its behaviour lives in
 * observability/rules/<code>.mjs, which exports `symptom`, `expected`, `applies` and `decide` (and `settle_ms` when records about
 * the item keep arriving after it ends, and `healthy_absent` when the proven absence of a required witness is the healthy claim). A symptom with no rule file yet is catalogued but not checked, and the coverage gate lists it.
 *
 * A slice adds a check by adding the symptom and its facts to the registry, the rule file, a positive and a healthy fixture under
 * observability/fixtures/<code>/ and a fault scenario. Nothing here changes.
 */
import { existsSync, readFileSync } from "node:fs";
import { rulesVersion } from "./verdict.mjs";

/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./profile.mjs").Requirement} Requirement */
/**
 * @typedef {{ fact: string, from: string[], required: boolean, independent: number, query: string }} Witness
 * @typedef {{ code: string, item: CheckDef["item"], per: CheckDef["per"], test_only?: boolean, witnesses: Witness[], rule: string }} Symptom
 */

const ROOT = new URL("../../../", import.meta.url);
const REGISTRY = new URL("observability/generated/registry.json", ROOT);

/** @param {Witness} witness @returns {Requirement} */
const requirement = ({ fact, from, independent, query }) => (independent > 1 ? { fact, from, independent, query } : { fact, from, query });

/**
 * Builds one check from its registry symptom and its rule module, and names the file at fault when the two disagree.
 * @param {Symptom} symptom
 * @param {Record<string, unknown>} rule
 * @returns {CheckDef}
 */
export function checkFrom(symptom, rule) {
  const where = `${symptom.rule}`;
  if (rule.symptom !== symptom.code) throw new TypeError(`${where} must export symptom = ${JSON.stringify(symptom.code)}`);
  if (typeof rule.applies !== "function" || typeof rule.decide !== "function") throw new TypeError(`${where} must export applies() and decide()`);
  if (typeof rule.expected !== "string" || rule.expected === "") throw new TypeError(`${where} must export expected, one sentence of what a healthy subject produces`);
  if (rule.settle_ms !== undefined && !(Number.isInteger(rule.settle_ms) && Number(rule.settle_ms) >= 0)) throw new TypeError(`${where}: settle_ms is a whole number of milliseconds`);
  const healthyAbsent = rule.healthy_absent ?? [];
  if (!Array.isArray(healthyAbsent) || !healthyAbsent.every((fact) => typeof fact === "string")) throw new TypeError(`${where}: healthy_absent is a list of required facts`);
  return Object.freeze({
    code: symptom.code,
    item: symptom.item,
    per: symptom.per,
    applies: /** @type {CheckDef["applies"]} */ (rule.applies),
    requires: Object.freeze(symptom.witnesses.filter((witness) => witness.required).map(requirement)),
    optional: Object.freeze(symptom.witnesses.filter((witness) => !witness.required).map(requirement)),
    expected: rule.expected,
    decide: /** @type {CheckDef["decide"]} */ (rule.decide),
    settle_ms: Number(rule.settle_ms ?? 0),
    healthy_absent: Object.freeze([...healthyAbsent]),
  });
}

/** @type {Symptom[]} */
const symptoms = JSON.parse(readFileSync(REGISTRY, "utf8")).symptoms.filter((/** @type {Symptom} */ symptom) => !symptom.test_only && existsSync(new URL(symptom.rule, ROOT)));
const modules = await Promise.all(symptoms.map(async (symptom) => /** @type {Record<string, unknown>} */ (await import(new URL(symptom.rule, ROOT).href))));

/** @type {readonly CheckDef[]} */
export const CATALOGUE = Object.freeze(symptoms.map((symptom, index) => checkFrom(symptom, modules[index])));
/** The rules version covers each rule file and its registry entry, so a changed threshold or witness changes RULES. */
export const RULES = rulesVersion(
  CATALOGUE,
  symptoms.flatMap((symptom) => [JSON.stringify(symptom), readFileSync(new URL(symptom.rule, ROOT), "utf8")]),
);
