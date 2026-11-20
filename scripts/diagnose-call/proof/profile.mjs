// @ts-check
/**
 * The profile: what one item (an Episode, an attempt that never became one, or a post-call job) should have produced, given what
 * the authority declared about it. It is chosen from the declaration alone, before any telemetry is read, so the evidence can never
 * shrink what it is judged against: an Episode whose board was declared on needs board evidence, whether or not any arrived.
 */

/** @typedef {import("./evidence.mjs").Window} Window */
/** @typedef {import("./evidence.mjs").Reading} Reading */
/** @typedef {import("./evidence.mjs").Observation} Observation */

/**
 * Declarations come from the authority: Postgres for Episodes, seats and jobs, and the attempt population (API and edge
 * request records) for attempts. Never from client or SFU telemetry. `to_ms: null` is an item that has not ended.
 *
 * @typedef {{ from_ms: number, to_ms: number | null }} OpenWindow
 * @typedef {{ kind: "user" | "agent", id: string, name: string | null } | { kind: "guest", device: string | null, name: string | null }} Person
 * @typedef {{ participant: string, name: string | null, role: string, can_publish: boolean, generations: readonly number[], connections: readonly string[], window: OpenWindow, person: Person }} Seat
 * @typedef {{ kind: "episode", id: string, tenant: string, features: readonly string[], window: OpenWindow, seats: readonly Seat[] }} EpisodeDeclaration
 * @typedef {{ kind: "attempt", id: string, tenant: string, window: OpenWindow }} AttemptDeclaration
 * @typedef {{ kind: "job", id: string, tenant: string, episode: string, job_kind: string, window: OpenWindow }} JobDeclaration
 * @typedef {EpisodeDeclaration | AttemptDeclaration | JobDeclaration} Declaration
 */

/**
 * One witness a check needs. `from` lists the sources that may witness the fact; each must cover the window before an absence or a
 * pass counts. `independent` is how many distinct origins must claim the fact before a pass counts (default 1). `query` is the proof
 * query template a reader reruns; `{episode}`, `{participant}`, `{attempt}`, `{job}`, `{from}` and `{to}` are filled in.
 * @typedef {{ fact: string, from: readonly string[], independent?: number, query: string }} Requirement
 */

/**
 * What a rule returns. A rule states facts and cites the evidence behind each one; a hypothesis is separate, optional, and names
 * what would falsify it. Times are windows, never text, so the CLI formats them against its own anchor.
 *
 * @typedef {{ text: string, evidence: readonly string[], window: Window | null, absent: string | null }} Fact
 * @typedef {{ text: string, falsified_by: string }} Hypothesis
 * @typedef {"broken" | "degraded" | "expected"} FindingOutcome
 * @typedef {{
 *   status: "finding",
 *   outcome: FindingOutcome,
 *   window: Window,
 *   hop: string | null,
 *   upstream: "witnessed" | "unknown" | null,
 *   observed: string,
 *   facts: readonly Fact[],
 *   hypothesis: Hypothesis | null,
 *   falsify: { absence: string | null, attribution: string | null },
 * }} FindingDecision
 * @typedef {{ status: "pass" } | { status: "unknown", reason: string } | FindingDecision} Decision
 *
 * - `hop`: the first hop of the witness chain where the observation diverged from what was expected (`sfu_ingress`).
 * - `upstream`: whether the hops before it were witnessed. `unknown` says the divergence may have started earlier.
 * - `observed`: one line of what the witnesses showed, for the proof view.
 */

/**
 * @typedef {{
 *   readings: Readonly<Record<string, Reading>>,
 *   failures: readonly Readonly<Observation>[],
 *   window: Window,
 *   declaration: Declaration,
 *   seat: Seat | null,
 * }} DecideInput
 * `failures` holds the item's failed outcomes (the seat's own, for a seat check), so an expected rule can claim the errors it explains.
 */

/**
 * One check: a symptom code and the rule that decides it. `applies` reads the declaration only, so the profile stays independent of
 * the telemetry. `expected` says in one sentence what a healthy subject produces; the proof view prints it.
 * @typedef {{
 *   code: string,
 *   item: Declaration["kind"],
 *   per: "item" | "seat",
 *   applies: (declaration: Declaration, seat: Seat | null) => boolean,
 *   requires: readonly Requirement[],
 *   optional: readonly Requirement[],
 *   expected: string,
 *   decide: (input: DecideInput) => Decision,
 * }} CheckDef
 */

/**
 * @typedef {{ key: string, code: string, subject: string, window: Window, seat: Seat | null }} PlannedCheck
 * @typedef {{ declaration: Readonly<Declaration>, window: Window, open: boolean, checks: readonly PlannedCheck[] }} Profile
 */

/** The subject key of an item-wide check, and of a seat. */
export const ITEM = "*";
/** @param {string} participant */
export const seatKey = (participant) => `pt:${participant}`;

/**
 * Plans every check that applies to the item. An item that has not ended is judged up to `asof_ms` and stays open, so it can never be
 * healthy: what it has not done yet is unknown.
 * @param {Declaration} declaration
 * @param {readonly CheckDef[]} catalogue
 * @param {number} asof_ms
 * @returns {Profile}
 */
export function profileFor(declaration, catalogue, asof_ms) {
  const open = declaration.window.to_ms === null;
  const window = { from_ms: declaration.window.from_ms, to_ms: declaration.window.to_ms ?? Math.max(asof_ms, declaration.window.from_ms) };
  /** @type {PlannedCheck[]} */
  const checks = [];
  for (const def of catalogue.filter((candidate) => candidate.item === declaration.kind)) {
    if (def.per === "item") {
      if (def.applies(declaration, null)) checks.push({ key: `${def.code}@${ITEM}`, code: def.code, subject: ITEM, window, seat: null });
      continue;
    }
    if (declaration.kind !== "episode") throw new TypeError(`check ${def.code}: per-seat checks apply to Episodes only`);
    for (const seat of declaration.seats) {
      if (!def.applies(declaration, seat)) continue;
      const from_ms = Math.max(window.from_ms, seat.window.from_ms);
      const to_ms = Math.min(window.to_ms, seat.window.to_ms ?? window.to_ms);
      checks.push({ key: `${def.code}@${seatKey(seat.participant)}`, code: def.code, subject: seatKey(seat.participant), window: { from_ms, to_ms: Math.max(from_ms, to_ms) }, seat });
    }
  }
  checks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return deepFreeze({ declaration: structuredClone(declaration), window, open, checks });
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
