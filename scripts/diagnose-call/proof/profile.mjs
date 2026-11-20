// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * The profile: what one item (an Episode, an attempt that never became one, a post-call job, or one UTC day of a Space, a Tenant or
 * the platform) should have produced, given what
 * the authority declared about it. It is chosen from the declaration alone, before any telemetry is read, so the evidence can never
 * shrink what it is judged against: an Episode whose board was declared on needs board evidence, whether or not any arrived.
 */

/** @typedef {import("./evidence.mjs").Window} Window */
/** @typedef {import("./evidence.mjs").Reading} Reading */
/** @typedef {import("./evidence.mjs").Observation} Observation */

/**
 * Declarations come from the authority: Postgres for Episodes, seats, jobs, Spaces and Tenants, the attempt population (API and edge
 * request records) for attempts, and the release markers for the platform. Never from client or SFU telemetry. `to_ms: null` is an
 * item that has not ended. An attempt is keyed by its client session id (`cs_`), the one id a client has before it has a seat.
 * A Space, Tenant or platform item is one UTC `day` of that subject, so its checks are aggregate and item-wide.
 *
 * @typedef {{ from_ms: number, to_ms: number | null }} OpenWindow
 * @typedef {{ kind: "user" | "agent", id: string, name: string | null } | { kind: "guest", device: string | null, name: string | null }} Person
 * @typedef {{ participant: string, name: string | null, role: string, can_publish: boolean, generations: readonly number[], connections: readonly string[], window: OpenWindow, person: Person }} Seat
 * @typedef {{ kind: "episode", id: string, tenant: string, features: readonly string[], window: OpenWindow, seats: readonly Seat[] }} EpisodeDeclaration
 * @typedef {{ kind: "attempt", id: string, tenant: string, window: OpenWindow }} AttemptDeclaration
 * @typedef {{ kind: "job", id: string, tenant: string, episode: string, job_kind: string, window: OpenWindow }} JobDeclaration
 * @typedef {{ kind: "space", id: string, tenant: string, day: string, window: OpenWindow, episodes: readonly string[] }} SpaceDeclaration
 * @typedef {{ kind: "tenant", id: string, tenant: string, day: string, window: OpenWindow }} TenantDeclaration
 * @typedef {{ kind: "platform", id: string, tenant: null, day: string, window: OpenWindow }} PlatformDeclaration `id` is the environment.
 * @typedef {EpisodeDeclaration | AttemptDeclaration | JobDeclaration | SpaceDeclaration | TenantDeclaration | PlatformDeclaration} Declaration
 */

/**
 * One witness a check needs. `from` lists the sources that may witness the fact; each must cover the window before an absence or a
 * pass counts. `independent` is how many distinct origins must claim the fact before a pass counts (default 1). `query` is the proof
 * query template a reader reruns; `{episode}`, `{participant}`, `{attempt}`, `{job}`, `{space}`, `{tenant}`, `{environment}`, `{day}`,
 * `{from}` and `{to}` are filled in.
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
 *   module: string | null,
 *   reason: string | null,
 *   upstream: "witnessed" | "unknown" | null,
 *   observed: string,
 *   facts: readonly Fact[],
 *   hypothesis: Hypothesis | null,
 *   falsify: { absence: string | null, attribution: string | null },
 * }} FindingDecision
 * @typedef {{ status: "pass" } | { status: "unknown", reason: string } | FindingDecision} Decision
 *
 * - `hop`: the first hop of the witness chain where the observation diverged from what was expected (`sfu_ingress`).
 * - `module`: the code that owns the hop, `<component>.<area>` from the registry's fault components (`sfu.ingress`), or `network` or
 *   `unknown`; null only when nothing failed.
 * - `reason`: the registry reason code an `expected` finding stands for (`end.time_limit`); null for every other outcome.
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
 *   settle_ms?: number,
 *   healthy_absent?: readonly string[],
 * }} CheckDef
 * `settle_ms` extends an ended item's window for this check, because some records about an end arrive after it (a client's end
 * screen). The sources must cover the extended window before the check counts.
 *
 * A check fails closed: the kernel turns a `pass` into `unknown` unless every required witness is present. `healthy_absent` names
 * the required facts whose proven absence is itself the healthy claim (no automatic board camera move, no ingress while muted), so
 * a pass over their absence stands; a fact not named there must be witnessed before the check can pass.
 */

/**
 * @typedef {{ key: string, code: string, subject: string, window: Window, seat: Seat | null }} PlannedCheck
 * @typedef {{ declaration: Readonly<Declaration>, window: Window, open: boolean, checks: readonly PlannedCheck[] }} Profile
 */

/** The subject key of an item-wide check, and of a seat. */
export const ITEM = "*";
/** @param {string} participant */
export const seatKey = (participant) => `pt:${participant}`;
/** The subject key of a per-seat source on an attempt, which has no seat yet: its client session. @param {string} attempt */
export const sessionKey = (attempt) => `cs:${attempt}`;

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
    const settle = open ? 0 : (def.settle_ms ?? 0);
    if (def.per === "item") {
      if (def.applies(declaration, null)) checks.push({ key: `${def.code}@${ITEM}`, code: def.code, subject: ITEM, window: { from_ms: window.from_ms, to_ms: window.to_ms + settle }, seat: null });
      continue;
    }
    if (declaration.kind !== "episode") throw new TypeError(`check ${def.code}: per-seat checks apply to Episodes only`);
    for (const seat of declaration.seats) {
      if (!def.applies(declaration, seat)) continue;
      const from_ms = Math.max(window.from_ms, seat.window.from_ms);
      const to_ms = Math.min(window.to_ms, seat.window.to_ms ?? window.to_ms) + settle;
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
