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
import { reportRows, dbRows } from "./report-store.mjs";

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
 *   status?: string, created_at: string, joined_at: string | null, left_at: string | null, account: string | null,
 *   identity: { id: string, kind: "user" | "agent", name: string } | null,
 * }} DbSeat
 * @typedef {{
 *   episode: { id: string, tenant: string, space: string, created_at: string, started_at: string | null, ended_at: string | null, end_reason: string | null },
 *   tenant: { id: string, name: string },
 *   seats: readonly DbSeat[],
 *   reports?: readonly Record<string, any>[],
 *   uploads?: readonly Record<string, any>[],
 *   requests?: readonly Record<string, any>[],
 *   sessions?: readonly Record<string, any>[],
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
const SERVICES = Object.freeze({ api: "chalk-api", sync: "chalk-sync", sfu: "chalk-sfu" });

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
 * not that the service dropped nothing before it. Only a witnessed immutable terminal fact can be certified, not the stream.
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
 * An ended Episode has exactly one authoritative reason. The matching Sync
 * witness can settle that fact, but cannot certify any other Sync record.
 * @param {DbEpisode["episode"]} episode
 * @param {readonly Row[]} rows
 */
function certifiedEnd(episode, rows) {
  if (episode.ended_at === null || episode.end_reason === null) return {};
  const witnesses = rows.filter((row) => row.service === SERVICES.sync && row.name === "sync.episode.ended" && row.kind === "fact");
  const matching = witnesses.find((row) => row.end_reason === episode.end_reason && typeof row.event_id === "string" && typeof row.est_server_ms === "number");
  if (!matching || witnesses.some((row) => row.end_reason !== episode.end_reason)) return {};
  return { certified_once: { "end.episode": /** @type {string} */ (matching.event_id) } };
}

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
 * @param {{ db: DbEpisode, ledger: Ledger, rows: readonly Row[], readbacks?: readonly import("../proof/evidence.mjs").Observation[], r2_read?: boolean, asof_ms: number }} input `rows` are Axiom rows
 *   as the API returns them. `readbacks` are the checker's r2 observations when `r2_read` ran.
 * @returns {{ world: World, notes: string[] }}
 */
export function liveWorld({ db, ledger: report, rows, readbacks = [], r2_read = false, asof_ms }) {
  const declaration = declarationOf(db);
  const ledger = boundLedger(report, declaration);
  const read = rows.map(unwrapRow).filter((row) => row.episode_id === declaration.id && row.tenant_id === declaration.tenant);
  const { usable: flat, ignored } = deliveredRows(read, "unavailable" in ledger ? [] : ledger.sources);
  const { observations, dropped } = observationsFromRows(flat);
  const at = { asof_ms, start_ms: declaration.window.from_ms };
  // The declaration read is one consistent Postgres snapshot: db and report observations claim the rows as it saw them,
  // and its sources are complete to the read. r2 is complete only when the checker's readbacks actually ran.
  const storeObs = [
    ...reportRows((db.reports ?? []).map((r) => ({ ...r, tenant_id: declaration.tenant, episode_id: declaration.id })), asof_ms),
    ...dbRows({
      seats: db.seats.map((seat) => ({ participant: seat.participant, status: seat.status, connection: seat.connection, created_at: seat.created_at, left_at: seat.left_at })),
      uploads: db.uploads ?? [],
      requests: db.requests ?? [],
      sessions: db.sessions ?? [],
      episode: declaration.id,
      tenant: declaration.tenant,
    }, asof_ms),
  ];
  /** @type {Readonly<Watermark>[]} */
  const watermarks = [
    ...declaration.seats.map((seat) => clientWatermark(seat, ledger, flat, at)),
    serverWatermark("api", flat),
    { ...serverWatermark("sync", flat), ...certifiedEnd(db.episode, flat) },
    serverWatermark("sfu", flat),
    { source: "db", subject: ITEM, complete_to_ms: asof_ms, evidence_gaps: [], emits: storeObs.filter((o) => o.source === "db").map((o) => o.fact), build: "postgres declaration" },
    { source: "report", subject: ITEM, complete_to_ms: asof_ms, evidence_gaps: [], emits: ["report.problem"], build: "postgres declaration" },
    { source: "r2", subject: ITEM, complete_to_ms: r2_read ? asof_ms : null, evidence_gaps: [], emits: ["report.readback"], build: "checker readback" },
  ];
  const evidence = { observations: [...observations, ...storeObs, ...(readbacks ?? [])], watermarks };
  /** @type {Map<string, World["sessions"][number]>} */
  const sessions = new Map();
  for (const row of flat) {
    if (typeof row.client_session_id === "string" && typeof row.participant_id === "string") sessions.set(row.client_session_id, { id: row.client_session_id, meaning: "client_session", episode: declaration.id, participant: row.participant_id });
  }
  // Sessions the Postgres store names: telemetry_sources rows, and the client session each report row carries, so a CHK
  // code scopes to the reporting session even when its telemetry stream closed before the check read.
  for (const s of db.sessions ?? []) {
    if (typeof s.source_id === "string" && !sessions.has(s.source_id)) sessions.set(s.source_id, { id: s.source_id, meaning: "client_session", episode: declaration.id, participant: s.participant_id });
  }
  for (const r of db.reports ?? []) {
    if (typeof r.client_session_id === "string" && !sessions.has(r.client_session_id)) sessions.set(r.client_session_id, { id: r.client_session_id, meaning: "client_session", episode: declaration.id, participant: r.participant_id });
  }
  const people = declaration.seats.flatMap((seat) => (seat.person.kind === "guest" ? [] : [{ kind: seat.person.kind, id: seat.person.id, name: seat.person.name ?? seat.person.id, tenant: declaration.tenant }]));
  const why = new Map();
  for (const drop of dropped) why.set(`${drop.event}: ${drop.why}`, (why.get(`${drop.event}: ${drop.why}`) ?? 0) + 1);
  const notes = [
    `read ${read.length} rows, ${observations.length} observations`,
    ...(ignored > 0 ? [`ignored ${ignored} client rows the ledger did not store, so they are not evidence`] : []),
    ...[...why].map(([reason, count]) => `dropped ${count} rows (${reason})`),
    `server sources ${Object.keys(SERVICES).join(", ")} have no complete delivery ledger; only the witnessed durable Episode end can be certified`,
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
