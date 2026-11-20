// @ts-check
/**
 * `check`: the only writer of verdicts, run on demand by an agent or a person. Nothing schedules it, so detection time is not
 * guaranteed, and an item nobody checked stays `unchecked`, never healthy.
 *
 * It enumerates more than ended Episodes: open Episodes, attempts that never became an Episode, and post-call jobs, each from the
 * population that knows it. It skips an item whose stored verdict is current (same evidence fingerprint and rules version) and
 * rechecks one whose evidence or rules changed, carrying its proven findings forward.
 *
 * The ports are async because the real adapters read Postgres, Axiom and R2. The reference adapters in fixture-world.mjs resolve
 * at once; a slice that wires a real source implements the same four methods.
 */
import { openBundle } from "./bundle.mjs";
import { profileFor } from "./profile.mjs";
import { judge } from "./verdict.mjs";

/** @typedef {import("./profile.mjs").Declaration} Declaration */
/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */
/** @typedef {import("./verdict.mjs").Verdict} Verdict */
/** @typedef {import("./verdict.mjs").Outcome} Outcome */

/**
 * @typedef {{ kind: Declaration["kind"], id: string, tenant: string, declaration: Declaration }} Item
 * @typedef {{ tenant: string | null, from_ms: number, to_ms: number } | { item: { kind: Declaration["kind"], id: string } }} Scope
 * @typedef {{ item: { kind: Declaration["kind"], id: string }, fingerprint: string, verdict: Verdict }} Stored
 * @typedef {{
 *   population: { items(scope: Scope): Promise<Item[]> },
 *   evidence: { fingerprint(item: Item): Promise<string>, read(item: Item): Promise<{ observations: Observation[], watermarks: Watermark[] }> },
 *   store: { get(item: Item): Promise<Stored | null>, put(stored: Stored): Promise<void> },
 * }} Ports
 *
 * - `population.items`: every item the scope holds, from the authority: Episodes (ended and open) and jobs from Postgres, attempts
 *   from the attempt population. An attempt that never became an Episode is listed here, not inferred from seats.
 * - `evidence.fingerprint`: a cheap digest that changes whenever the item's evidence would (row count, latest ingest, watermarks).
 * - `evidence.read`: the item's observations and folded watermarks, already in the shapes evidence.mjs checks.
 */

/**
 * @typedef {{ state: "unchecked" }
 *   | { state: "stale", stored: Stored, why: "evidence" | "rules" }
 *   | { state: "current", stored: Stored }} Status
 */

/**
 * Whether an item's stored verdict is current, stale or missing. Reading this never writes.
 * @param {Item} item
 * @param {Ports} ports
 * @param {string} rules
 * @returns {Promise<Status>}
 */
export async function statusOf(item, ports, rules) {
  const stored = await ports.store.get(item);
  if (stored === null) return { state: "unchecked" };
  if (stored.fingerprint !== (await ports.evidence.fingerprint(item))) return { state: "stale", stored, why: "evidence" };
  if (stored.verdict.rules !== rules) return { state: "stale", stored, why: "rules" };
  return { state: "current", stored };
}

/**
 * What a reader may conclude from a status. A stale verdict keeps its proven findings (broken stays broken) but loses `healthy`,
 * because new evidence has not been checked; an unchecked item is `unknown` with coverage `unchecked`.
 * @param {Status} status
 * @returns {{ outcome: Outcome, coverage: "complete" | "partial" | "stale" | "unchecked", verdict: Verdict | null }}
 */
export function standing(status) {
  if (status.state === "unchecked") return { outcome: "unknown", coverage: "unchecked", verdict: null };
  const { verdict } = status.stored;
  if (status.state === "stale") return { outcome: verdict.outcome === "healthy" ? "unknown" : verdict.outcome, coverage: "stale", verdict };
  return { outcome: verdict.outcome, coverage: verdict.coverage.state, verdict };
}

/**
 * Checks every item in the scope that has no current verdict.
 * @param {Scope} scope
 * @param {Ports} ports
 * @param {{ catalogue: readonly CheckDef[], rules: string, asof_ms: number }} options
 * @returns {Promise<{ item: Item, action: "checked" | "rechecked" | "current", was: Outcome | null, verdict: Verdict }[]>}
 */
export async function check(scope, ports, { catalogue, rules, asof_ms }) {
  const items = (await ports.population.items(scope)).sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1));
  const results = [];
  for (const item of items) {
    const status = await statusOf(item, ports, rules);
    if (status.state === "current") {
      results.push({ item, action: /** @type {const} */ ("current"), was: null, verdict: status.stored.verdict });
      continue;
    }
    const prior = status.state === "stale" ? status.stored.verdict : null;
    const fingerprint = await ports.evidence.fingerprint(item);
    const verdict = await judgeItem(item, ports, { catalogue, rules, asof_ms, prior });
    await ports.store.put({ item: { kind: item.kind, id: item.id }, fingerprint, verdict });
    results.push({ item, action: prior ? /** @type {const} */ ("rechecked") : /** @type {const} */ ("checked"), was: prior?.outcome ?? null, verdict });
  }
  return results;
}

/**
 * Profile first, from the declaration alone; then the evidence; then the seal; then the verdict.
 * @param {Item} item
 * @param {Ports} ports
 * @param {{ catalogue: readonly CheckDef[], rules: string, asof_ms: number, prior: Verdict | null }} options
 * @returns {Promise<Verdict>}
 */
export async function judgeItem(item, ports, { catalogue, rules, asof_ms, prior }) {
  const profile = profileFor(item.declaration, catalogue, asof_ms);
  const bundle = openBundle(profile, { asof_ms });
  const { observations, watermarks } = await ports.evidence.read(item);
  for (const o of observations) bundle.add(o);
  for (const w of watermarks) bundle.watermark(w);
  return judge(bundle.seal(), catalogue, { rules, prior });
}
