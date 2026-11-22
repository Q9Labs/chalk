// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
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
 *
 * Two checks of one item may run at once. Each judges one evidence snapshot (the rows and the fingerprint of those same rows) against
 * the prior it read, and writes only if that prior is still the stored one. A check that loses the race reads the new prior and
 * judges again, so a proven finding another check stored is carried forward, never overwritten by a verdict that never saw it.
 */
import { createHash } from "node:crypto";
import { canonical, openBundle } from "./bundle.mjs";
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
 * @typedef {{ item: { kind: Declaration["kind"], id: string }, declaration: string, fingerprint: string, verdict: Verdict }} Entry
 * @typedef {Entry & { revision: number }} Stored
 * @typedef {{ observations: Observation[], watermarks: Watermark[], fingerprint: string }} Snapshot
 * @typedef {{
 *   population: { items(scope: Scope): Promise<Item[]> },
 *   evidence: { fingerprint(item: Item): Promise<string>, read(item: Item): Promise<Snapshot> },
 *   store: { get(item: Item): Promise<Stored | null>, put(entry: Entry, condition: { expect: number | null }): Promise<boolean> },
 * }} Ports
 *
 * - `population.items`: every item the scope holds, from the authority: Episodes (ended and open) and jobs from Postgres, attempts
 *   from the attempt population. An attempt that never became an Episode is listed here, not inferred from seats.
 * - `evidence.fingerprint`: a cheap digest that changes whenever the item's evidence would (row count, latest ingest, watermarks).
 * - `evidence.read`: the item's observations and folded watermarks, already in the shapes evidence.mjs checks, with the fingerprint of
 *   exactly that snapshot, so the stored fingerprint always describes the evidence the verdict judged.
 * - `store.put`: writes only when the stored revision is `expect` (`null`: no verdict is stored), and says whether it wrote. Each write
 *   gets the next revision.
 */

/** A check that loses this many write races in a row stops rather than loop: something keeps rewriting the item. */
const MAX_ATTEMPTS = 5;

/**
 * @typedef {{ state: "unchecked" }
 *   | { state: "stale", stored: Stored, why: "declaration" | "evidence" | "rules" }
 *   | { state: "current", stored: Stored }} Status
 */

/**
 * The profile is planned from the declaration, so a verdict judged under another declaration (a seat added, a feature enabled, the
 * window closed) planned other checks and is stale, whatever the evidence says.
 * @param {Declaration} declaration
 */
export const declarationDigest = (declaration) => createHash("sha256").update(canonical(declaration)).digest("hex").slice(0, 16);

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
  if (stored.declaration !== declarationDigest(item.declaration)) return { state: "stale", stored, why: "declaration" };
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
  for (const item of items) results.push(await checkItem(item, ports, { catalogue, rules, asof_ms }));
  return results;
}

/**
 * One item: read its prior, judge one snapshot against it, and write on condition that the prior is still the stored one.
 * @param {Item} item
 * @param {Ports} ports
 * @param {{ catalogue: readonly CheckDef[], rules: string, asof_ms: number }} options
 */
async function checkItem(item, ports, { catalogue, rules, asof_ms }) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const status = await statusOf(item, ports, rules);
    if (status.state === "current") return { item, action: /** @type {const} */ ("current"), was: null, verdict: status.stored.verdict };
    const prior = status.state === "stale" ? status.stored.verdict : null;
    const snapshot = await ports.evidence.read(item);
    const verdict = judgeSnapshot(item, snapshot, { catalogue, rules, asof_ms, prior });
    const entry = { item: { kind: item.kind, id: item.id }, declaration: declarationDigest(item.declaration), fingerprint: snapshot.fingerprint, verdict };
    const expect = status.state === "stale" ? status.stored.revision : null;
    if (await ports.store.put(entry, { expect })) return { item, action: prior ? /** @type {const} */ ("rechecked") : /** @type {const} */ ("checked"), was: prior?.outcome ?? null, verdict };
  }
  throw new Error(`check ${item.kind} ${item.id}: another check rewrote its verdict ${MAX_ATTEMPTS} times while this one judged it`);
}

/**
 * Profile first, from the declaration alone; then the evidence of one snapshot; then the seal; then the verdict.
 * @param {Item} item
 * @param {{ observations: readonly Observation[], watermarks: readonly Watermark[] }} snapshot
 * @param {{ catalogue: readonly CheckDef[], rules: string, asof_ms: number, prior: Verdict | null }} options
 * @returns {Verdict}
 */
export function judgeSnapshot(item, { observations, watermarks }, { catalogue, rules, asof_ms, prior }) {
  const profile = profileFor(item.declaration, catalogue, asof_ms);
  const bundle = openBundle(profile, { asof_ms });
  for (const o of observations) bundle.add(o);
  for (const w of watermarks) bundle.watermark(w);
  return judge(bundle.seal(), catalogue, { rules, prior });
}
