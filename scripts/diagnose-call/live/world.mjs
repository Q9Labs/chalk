// @ts-check
/**
 * The live World: one Episode as the real stores hold it, in the same shape as a fixture world, so `check` and every view read it
 * through the reference adapters in proof/fixture-world.mjs. This file is pure: stores.mjs reads Postgres, Axiom and the telemetry
 * ledger and hands the results here.
 *
 * - The declaration and seats come from Postgres, the authority, never from telemetry.
 * - Observations come from Axiom rows through proof/rows.mjs, the one row mapping.
 * - A client source's watermark comes from the telemetry ledger (`telemetry-watermarks`), with its seq gaps placed in time by the
 *   source's own rows. A seat no ledger source names is not read.
 * - A server source's watermark is how far Axiom holds that service's rows.
 */
import { readFileSync } from "node:fs";
import { FACTS } from "../proof/facts.mjs";
import { ITEM, seatKey } from "../proof/profile.mjs";
import { observationsFromRows } from "../proof/rows.mjs";

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
 * @typedef {{ source_id: string, watermark: { participants: readonly string[], next_seq: number, end: "closed" | "abandoned" | null, stored: readonly SeqRange[] | null }, gaps: readonly LedgerGap[] }} LedgerSource
 * @typedef {{ tenant_id: string, episode_id: string, sources: readonly LedgerSource[] } | { unavailable: string }} Ledger
 */

/** The service name each server source's rows carry in Axiom. */
export const SERVICES = Object.freeze({ api: "chalk-api", sync: "chalk-sync", sfu: "chalk-sfu" });

const registry = JSON.parse(readFileSync(new URL("../../../observability/generated/registry.json", import.meta.url), "utf8"));
/** Registry events that still reach Axiom under an older name (`client.call_ended` arrives as an `sdk.telemetry` row of type `call_ended`). */
const LEGACY = registry.events.flatMap((/** @type {{ name: string, legacy?: { match?: Record<string, string> } }} */ event) => (event.legacy?.match ? [{ name: event.name, match: Object.entries(event.legacy.match) }] : []));

/**
 * One Axiom row as the row adapter reads it: the event fields (Axiom nests them under `attributes`) at the top, the service name as
 * `service`, and a legacy row renamed to its registry event by the registry's own match.
 * @param {Readonly<Record<string, any>>} raw
 * @returns {Row}
 */
export function unwrapRow(raw) {
  const { attributes, service, ...rest } = raw;
  /** @type {Record<string, unknown>} */
  const row = { ...rest, ...(attributes && typeof attributes === "object" ? attributes : {}) };
  if (typeof service?.name === "string") row.service = service.name;
  else if (typeof raw["service.name"] === "string") row.service = raw["service.name"];
  const legacy = LEGACY.find((/** @type {{ match: [string, string][] }} */ entry) => entry.match.every(([field, value]) => row[field] === value));
  if (legacy) row.event = legacy.name;
  return row;
}

/** @param {string | null} at */
const ms = (at) => (at === null ? null : Date.parse(at));

/**
 * @param {DbEpisode} db
 * @returns {EpisodeDeclaration}
 */
export function declarationOf(db) {
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
 * The facts the registry lets a source emit. Per-build emits are unproved until a build registry exists, so every build of a source
 * is taken to emit everything its source is registered for.
 * @param {string} source
 */
export const emitsOf = (source) =>
  Object.entries(FACTS)
    .filter(([, def]) => def.events.some((event) => event.source === source))
    .map(([fact]) => fact);

/**
 * Where one ledger source's records stop and where its gaps fall in time, from the source's own rows (`source_id`, `seq`,
 * `est_server_ms` widened by `clock_err_ms`). A gap runs from the earlier to the later of its neighbours, the last row before it
 * (the Episode's start when there is none) and the first row at or after its end, so a clock that stepped back between them still
 * leaves the gap covering both; it has no end when the ledger knows none or no later row exists. A seq the ledger stored but Axiom
 * returned no timed row for is a gap too (`unread`): its record was never read, so it can't count as absent. A closed source is
 * complete to `asof_ms`; any other is complete only to its highest stored row that Axiom returned.
 * @param {LedgerSource} source
 * @param {readonly Row[]} rows
 * @param {{ asof_ms: number, start_ms: number }} at
 * @returns {{ complete_to_ms: number | null, evidence_gaps: EvidenceGap[] }}
 */
export function sourceCoverage(source, rows, { asof_ms, start_ms }) {
  const timed = rows
    .flatMap((row) => {
      if (row.source_id !== source.source_id || typeof row.seq !== "number" || typeof row.est_server_ms !== "number") return [];
      const err = typeof row.clock_err_ms === "number" ? row.clock_err_ms : 0;
      return [{ seq: row.seq, at: row.est_server_ms, from: row.est_server_ms - err, to: row.est_server_ms + err }];
    })
    .sort((a, b) => a.seq - b.seq);
  const read = new Set(timed.map((row) => row.seq));
  const place = (/** @type {number} */ from_seq, /** @type {number | null} */ to_seq, /** @type {string} */ reason) => {
    const prev = timed.findLast((row) => row.seq < from_seq);
    const next = to_seq === null ? undefined : timed.find((row) => row.seq >= to_seq);
    return {
      from_ms: Math.min(prev?.from ?? start_ms, next?.from ?? Infinity),
      to_ms: next === undefined ? null : Math.max(next.to, prev?.to ?? -Infinity),
      reason,
    };
  };
  /** @type {LedgerGap[]} */
  const unread = [];
  for (const range of source.watermark.stored ?? []) {
    for (let seq = range.from; seq < range.to; seq += 1) {
      if (read.has(seq)) continue;
      const run = unread.at(-1);
      if (run !== undefined && run.to_seq === seq) unread[unread.length - 1] = { ...run, to_seq: seq + 1 };
      else unread.push({ source_id: source.source_id, from_seq: seq, to_seq: seq + 1, cause: "unread", status: "open" });
    }
  }
  const evidence_gaps = [...source.gaps, ...unread]
    .sort((a, b) => a.from_seq - b.from_seq)
    .map((gap) => place(gap.from_seq, gap.to_seq, `${gap.cause}${gap.drop_reason ? `(${gap.drop_reason})` : ""} seq ${gap.from_seq}..${gap.to_seq ?? "?"} ${gap.status}`));
  if (source.watermark.end === "closed") return { complete_to_ms: asof_ms, evidence_gaps };
  const stored = source.watermark.stored ?? [];
  const highest = stored.length === 0 ? null : Math.max(...stored.map((range) => range.to - 1));
  const last = highest === null ? undefined : timed.findLast((row) => row.seq <= highest);
  return { complete_to_ms: last?.at ?? null, evidence_gaps };
}

/**
 * The client watermark of one seat, folded over every ledger source that names its Participant: complete only as far as the least
 * complete of them, with every gap. A seat no source names was not read.
 * @param {string} participant
 * @param {Ledger} ledger
 * @param {readonly Row[]} rows
 * @param {{ asof_ms: number, start_ms: number }} at
 * @returns {Watermark}
 */
export function clientWatermark(participant, ledger, rows, at) {
  const subject = seatKey(participant);
  const base = { source: "client", subject, emits: emitsOf("client") };
  if ("unavailable" in ledger) return { ...base, complete_to_ms: null, evidence_gaps: [], build: `client (ledger unread: ${ledger.unavailable})` };
  const sources = ledger.sources.filter((source) => source.watermark.participants.includes(participant));
  if (sources.length === 0) return { ...base, complete_to_ms: null, evidence_gaps: [], build: "client (no ledger source)" };
  const covered = sources.map((source) => sourceCoverage(source, rows, at));
  const ends = covered.map((c) => c.complete_to_ms);
  const complete_to_ms = ends.includes(null) ? null : Math.min(.../** @type {number[]} */ (ends));
  return { ...base, complete_to_ms, evidence_gaps: covered.flatMap((c) => c.evidence_gaps), build: `client (${sources.length} ledger source${sources.length === 1 ? "" : "s"})` };
}

/**
 * A server source's watermark. Server sources are not ledger-delivered, so `complete_to_ms` is the latest `_time` Axiom holds for
 * the service: that proves the read reached that far, not that the service dropped nothing before it. No rows at all is not read.
 * @param {keyof typeof SERVICES} source
 * @param {number | null} latest_ms
 * @returns {Watermark}
 */
export const serverWatermark = (source, latest_ms) => ({ source, subject: ITEM, complete_to_ms: latest_ms, evidence_gaps: [], emits: emitsOf(source), build: `${SERVICES[source]} (Axiom ingest, drops unproved)` });

/**
 * The World for one Episode. The check runs once on open (as `history`), so a view shows the verdict the evidence just read gives.
 * @param {{ db: DbEpisode, ledger: Ledger, rows: readonly Readonly<Record<string, any>>[], latest: Readonly<Record<string, number | null>>, asof_ms: number }} input
 *   `rows` are Axiom rows as the API returns them; `latest` is each service's latest `_time` in ms.
 * @returns {{ world: World, notes: string[] }}
 */
export function liveWorld({ db, ledger, rows, latest, asof_ms }) {
  const declaration = declarationOf(db);
  const flat = rows.map(unwrapRow).filter((row) => row.episode_id === declaration.id);
  const { observations, dropped } = observationsFromRows(flat);
  const at = { asof_ms, start_ms: declaration.window.from_ms };
  const watermarks = [
    ...declaration.seats.map((seat) => clientWatermark(seat.participant, ledger, flat, at)),
    ...Object.entries(SERVICES).map(([source, service]) => serverWatermark(/** @type {keyof typeof SERVICES} */ (source), latest[service] ?? null)),
  ];
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
    `read ${flat.length} rows, ${observations.length} observations`,
    ...[...why].map(([reason, count]) => `dropped ${count} rows (${reason})`),
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
