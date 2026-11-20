// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
/**
 * The live World: one Episode as the real stores hold it, in the same shape as a fixture world, so `check` and every view read it
 * through the reference adapters in proof/fixture-world.mjs. This file is pure: stores.mjs reads Postgres, Axiom and the telemetry
 * ledger and hands the results here.
 *
 * - The declaration and seats come from Postgres, the authority, never from telemetry.
 * - Observations come from Axiom rows through proof/rows.mjs, the one row mapping. A client row is evidence only when the ledger
 *   stored its `(source_id, seq)`; any other client row is ignored and counted in the notes.
 * - A client source's watermark comes from the telemetry ledger (`telemetry-watermarks`), with its seq gaps placed in time by the
 *   source's own stored rows. A seat no ledger source of this Tenant and Episode names is not read.
 * - A server source has no delivery ledger, so nothing proves it dropped nothing: its watermark is not read, however recent its rows.
 * - A watermark emits only the facts its rows show at every build they came from, because no build registry says what a build can
 *   emit. A fact never seen at a build reads as not emitted, so its absence is unknown, never proven.
 */
import { ITEM } from "../proof/profile.mjs";
import { observationsFromRows } from "../proof/rows.mjs";
import { deliveredRows, observedEmits } from "./delivery.mjs";
import { clientWatermark } from "./watermarks.mjs";

/** @typedef {import("../proof/fixture-world.mjs").World} World */
/** @typedef {import("../proof/profile.mjs").EpisodeDeclaration} EpisodeDeclaration */
/** @typedef {import("../proof/profile.mjs").Seat} Seat */
/** @typedef {import("../proof/evidence.mjs").Watermark} Watermark */
/** @typedef {import("../proof/evidence.mjs").EvidenceGap} EvidenceGap */
/** @typedef {Readonly<Record<string, unknown>>} Row */

/**
 * What Postgres declares about one Episode. Times are what `json_build_object` writes for a timestamptz.
 * @typedef {{
 *   participant: string, name: string | null, role: string, capabilities: readonly string[], generation: number, connection: string | null,
 *   created_at: string, joined_at: string | null, left_at: string | null, account: string | null,
 *   identity: { id: string, kind: "user" | "agent", name: string } | null,
 * }} DbSeat
 * @typedef {{
 *   episode: { id: string, tenant: string, space: string, created_at: string, started_at: string | null, ended_at: string | null, end_reason: string | null },
 *   tenant: { id: string, name: string },
 *   seats: readonly DbSeat[],
 * }} DbEpisode
 */

/**
 * `telemetry-watermarks` output, or why the ledger could not be read.
 * @typedef {{ from: number, to: number }} SeqRange
 * @typedef {{ source_id: string, from_seq: number, to_seq: number | null, cause: string, drop_reason?: string, status: "open" | "final" }} LedgerGap
 * @typedef {{
 *   source_id: string,
 *   watermark: { tenant_id: string, participants: readonly string[], episodes: readonly string[], next_seq: number, end: "closed" | "abandoned" | null, stored: readonly SeqRange[] | null, rejected?: readonly SeqRange[] | null, last_received_at?: string },
 *   gaps: readonly LedgerGap[],
 * }} LedgerSource
 * @typedef {{ tenant_id: string, episode_id: string, sources: readonly LedgerSource[] } | { unavailable: string }} Ledger
 */

/** The service name each server source's rows carry in Axiom. */
export const SERVICES = Object.freeze({ api: "chalk-api", sync: "chalk-sync", sfu: "chalk-sfu" });

/**
 * One Axiom row as the row adapter reads it: the event fields (Axiom nests them under `attributes`) at the top and the service name
 * as `service`. The row keeps its own fields: the row adapter reads its event (proof/rows.mjs `eventOf`).
 * @param {Readonly<Record<string, any>>} raw
 * @returns {Row}
 */
export function unwrapRow(raw) {
  const { attributes, service, ...rest } = raw;
  /** @type {Record<string, unknown>} */
  const row = { ...rest, ...(attributes && typeof attributes === "object" ? attributes : {}) };
  if (typeof service?.name === "string") row.service = service.name;
  else if (typeof raw["service.name"] === "string") row.service = raw["service.name"];
  return row;
}

/** @param {string | null} at */
const ms = (at) => (at === null ? null : Date.parse(at));

/**
 * @param {DbEpisode} db
 * @returns {EpisodeDeclaration}
 */
function declarationOf(db) {
  const from_ms = /** @type {number} */ (ms(db.episode.started_at ?? db.episode.created_at));
  const to_ms = ms(db.episode.ended_at);
  const capable = (/** @type {(capability: string) => boolean} */ test) => db.seats.some((seat) => seat.capabilities.some(test));
  // Features read the declaration only: every Episode is a call, a board is declared when any seat may draw on it, and a time limit
  // when the API ended the Episode at its maximum duration.
  const features = ["media", ...(capable((c) => c === "drawWhiteboard" || c === "manageWhiteboard") ? ["board"] : []), ...(db.episode.end_reason === "maximum_duration" ? ["time_limit"] : [])];
  const seats = db.seats.map((seat) => {
    /** @type {Seat["person"]} */
    const person = seat.identity ? { kind: seat.identity.kind, id: seat.identity.id, name: seat.identity.name } : seat.account ? { kind: "user", id: seat.account, name: seat.name } : { kind: "guest", device: null, name: seat.name };
    return {
      participant: seat.participant,
      name: seat.name,
      role: seat.role,
      can_publish: seat.capabilities.some((c) => c.startsWith("publish")),
      generations: [seat.generation],
      connections: seat.connection === null ? [] : [seat.connection],
      window: { from_ms: /** @type {number} */ (ms(seat.joined_at ?? seat.created_at)), to_ms: ms(seat.left_at) },
      person,
    };
  });
  return { kind: "episode", id: db.episode.id, tenant: db.episode.tenant, features, window: { from_ms, to_ms }, seats };
}

/**
 * A server source's watermark. Server sources are not ledger-delivered, and a recent row proves only that the read reached that far,
 * not that the service dropped nothing before it, so a server source is never read as complete. Its rows still count as present.
 * @param {keyof typeof SERVICES} source
 * @param {readonly Row[]} rows every row of the Episode
 * @returns {Watermark}
 */
const serverWatermark = (source, rows) => ({
  source,
  subject: ITEM,
  complete_to_ms: null,
  evidence_gaps: [],
  emits: observedEmits(
    rows.filter((row) => row.service === SERVICES[source]),
    source,
  ),
  build: `${SERVICES[source]} (no delivery ledger)`,
});

/**
 * The ledger sources of this Tenant and Episode. A report or source for another one is not read, so it can't cover a seat here.
 * @param {Ledger} ledger
 * @param {EpisodeDeclaration} declaration
 * @returns {Ledger}
 */
const boundLedger = (ledger, declaration) => {
  if ("unavailable" in ledger) return ledger;
  if (ledger.tenant_id !== declaration.tenant || ledger.episode_id !== declaration.id) return { unavailable: "the ledger report names another Tenant or Episode" };
  return { ...ledger, sources: ledger.sources.filter((source) => source.watermark.tenant_id === declaration.tenant && source.watermark.episodes.includes(declaration.id)) };
};

/**
 * The World for one Episode. The check runs once on open (as `history`), so a view shows the verdict the evidence just read gives.
 * @param {{ db: DbEpisode, ledger: Ledger, rows: readonly Readonly<Record<string, any>>[], asof_ms: number }} input `rows` are Axiom rows
 *   as the API returns them.
 * @returns {{ world: World, notes: string[] }}
 */
export function liveWorld({ db, ledger: report, rows, asof_ms }) {
  const declaration = declarationOf(db);
  const ledger = boundLedger(report, declaration);
  const read = rows.map(unwrapRow).filter((row) => row.episode_id === declaration.id);
  const { usable: flat, ignored } = deliveredRows(read, "unavailable" in ledger ? [] : ledger.sources);
  const { observations, dropped } = observationsFromRows(flat);
  const at = { asof_ms, start_ms: declaration.window.from_ms };
  const watermarks = [...declaration.seats.map((seat) => clientWatermark(seat, ledger, flat, at)), ...Object.keys(SERVICES).map((source) => serverWatermark(/** @type {keyof typeof SERVICES} */ (source), flat))];
  const evidence = { observations: [...observations], watermarks };
  /** @type {Map<string, World["sessions"][number]>} */
  const sessions = new Map();
  for (const row of flat) {
    if (typeof row.client_session_id === "string" && typeof row.participant_id === "string") sessions.set(row.client_session_id, { id: row.client_session_id, meaning: "client_session", episode: declaration.id, participant: row.participant_id });
  }
  const people = declaration.seats.flatMap((seat) => (seat.person.kind === "guest" ? [] : [{ kind: seat.person.kind, id: seat.person.id, name: seat.person.name ?? seat.person.id, tenant: declaration.tenant }]));
  const why = new Map();
  for (const drop of dropped) why.set(`${drop.event}: ${drop.why}`, (why.get(`${drop.event}: ${drop.why}`) ?? 0) + 1);
  const notes = [
    `read ${read.length} rows, ${observations.length} observations`,
    ...(ignored > 0 ? [`ignored ${ignored} client rows the ledger did not store, so they are not evidence`] : []),
    ...[...why].map(([reason, count]) => `dropped ${count} rows (${reason})`),
    `server sources ${Object.keys(SERVICES).join(", ")} have no delivery ledger, so they are not read as complete`,
    ...("unavailable" in ledger ? [`telemetry ledger unread, so every seat's client source is not read: ${ledger.unavailable}`] : []),
  ];
  return {
    world: {
      asof_ms,
      tenants: [{ id: db.tenant.id, name: db.tenant.name, tz: "UTC" }],
      people: [...new Map(people.map((person) => [person.id, person])).values()],
      declarations: [declaration],
      sessions: [...sessions.values()],
      evidence: { [declaration.id]: evidence },
      history: [{ item: declaration.id, asof_ms, evidence }],
    },
    notes,
  };
}
