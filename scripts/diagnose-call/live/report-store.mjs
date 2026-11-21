// @ts-check
/**
 * The report store as observations: the `problem_reports`, `diagnostic_uploads`, `live_introspection_requests`,
 * `participants` and `telemetry_sources` rows one psql read returns, folded into kernel observations for the `db` and
 * `report` sources. Both readers share it — the live world (`live/world.mjs` over `--live` Postgres) and the dev
 * evidence reader (`scripts/problem-reports/evidence.mjs`) — so a stored row reads the same way wherever it was found.
 *
 * Every observation is `origin.measured(<source>)` over `[row created .. the read]`: a checker-read fact claims the row
 * as it stands now over the subject's whole life, and the kernel keeps only what overlaps the judged window. Ids are
 * deterministic over the row's identity so a fixture capture and a live read cite the same event.
 */
import { createHash } from "node:crypto";
import { observation, origin } from "../proof/evidence.mjs";

/** @typedef {import("../proof/evidence.mjs").Observation} Observation */

const ms = (/** @type {unknown} */ v) => (v === null || v === undefined ? null : Date.parse(/** @type {string} */ (v)));

/** Deterministic event id for a checker-read row: uuid-shaped over the row's identity. */
export const eventId = (/** @type {string} */ kind, /** @type {string[]} */ ...parts) => {
  const hex = createHash("sha256").update([kind, ...parts].join("|")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * One `report.problem` observation per stored report row; the claim is the picked symptom.
 * @param {readonly Record<string, any>[]} reports rows with tenant_id, episode_id set
 * @param {number} readMs
 * @returns {Readonly<Observation>[]}
 */
export function reportRows(reports, readMs) {
  return reports.map((r) => {
    const created = ms(r.created_at) ?? readMs;
    return observation({
      id: eventId("ev", "report.db", r.id),
      fact: "report.problem",
      source: "report",
      origin: origin.measured("report"),
      subject: { tenant: r.tenant_id, episode: r.episode_id, participant: r.participant_id, attempt: r.client_session_id },
      window: { from_ms: created, to_ms: readMs },
      claim: String(r.picked_symptom),
      value: {
        report_id: r.id, journey_id: r.journey_id, chk_code: r.chk_code, picked_symptom: r.picked_symptom,
        forward_outcome: r.forward_outcome, created_ms: created,
        ...(r.sdk_version ? { sdk_version: r.sdk_version } : {}),
      },
      failure: false,
      query: `psql -c "select * from problem_reports where id = '${r.id}'"`,
    });
  });
}

/**
 * `db` observations: `report.seat` per participants row, `report.upload_row` per diagnostic_uploads row,
 * `live.request` per live_introspection_requests row, `live.client_presence` per telemetry_sources row.
 * @param {{ seats: readonly Record<string, any>[], uploads: readonly Record<string, any>[], requests: readonly Record<string, any>[], sessions: readonly Record<string, any>[], episode: string, tenant: string }} db
 * @param {number} readMs
 * @returns {Readonly<Observation>[]}
 */
export function dbRows({ seats, uploads, requests, sessions, episode, tenant }, readMs) {
  /** @type {Readonly<Observation>[]} */
  const obs = [];
  for (const p of seats) {
    obs.push(observation({
      id: eventId("ev", "report.db_participant", p.participant),
      fact: "report.seat", source: "db", origin: origin.measured("db"),
      subject: { tenant, episode, participant: p.participant, ...(p.connection ? { connection: p.connection } : {}) },
      window: { from_ms: ms(p.created_at) ?? readMs, to_ms: readMs },
      claim: String(p.status ?? "unknown"),
      value: { participant_status: p.status, ...(p.left_at ? { seat_left_ms: ms(p.left_at) } : {}) },
      failure: false, query: `psql -c "select * from participants where id = '${p.participant}'"`,
    }));
  }
  for (const u of uploads) {
    const issued = ms(u.issued_at) ?? readMs;
    obs.push(observation({
      id: eventId("ev", "report.db_upload", u.id),
      fact: "report.upload_row", source: "db", origin: origin.measured("db"),
      subject: { tenant, episode, ...(u.participant_id ? { participant: u.participant_id } : {}) },
      window: { from_ms: issued, to_ms: readMs },
      claim: String(u.state),
      value: {
        diagnostic_upload_id: u.id, upload_trigger: u.trigger, upload_state: u.state, issued_ms: issued,
        ...(u.report_id ? { report_id: u.report_id } : {}), ...(u.live_request_id ? { live_request_id : u.live_request_id } : {}),
        ...(u.stored_at ? { stored_ms: ms(u.stored_at) } : {}), ...(u.failed_at ? { failed_ms: ms(u.failed_at) } : {}),
        ...(u.expires_at ? { expires_ms: ms(u.expires_at) } : {}), ...(u.bytes != null ? { bytes: u.bytes } : {}), ...(u.sha256 ? { sha256: u.sha256 } : {}),
      },
      failure: false, query: `psql -c "select * from diagnostic_uploads where id = '${u.id}'"`,
    }));
  }
  for (const l of requests) {
    const requested = ms(l.requested_at) ?? readMs;
    const status = l.delivery === null || l.delivery === undefined ? "pending" : l.delivery;
    obs.push(observation({
      id: eventId("ev", "live.db_request", l.id),
      fact: "live.request", source: "db", origin: origin.measured("db"),
      subject: { tenant, episode, participant: l.participant_id },
      window: { from_ms: requested, to_ms: readMs },
      claim: status,
      value: {
        live_request_id: l.id, request_status: status, requested_ms: requested,
        expires_ms: ms(l.expires_at), participant_status: l.participant_status, episode_status: l.episode_status,
        ...(l.seat_left_at ? { seat_left_ms: ms(l.seat_left_at) } : {}),
        ...(l.delivery ? { delivery: l.delivery } : {}), ...(l.delivered_at ? { delivered_ms: ms(l.delivered_at) } : {}),
        ...(l.sockets != null ? { sockets: l.sockets } : {}), ...(l.unavailable_reason ? { unavailable_reason: l.unavailable_reason } : {}),
      },
      failure: false, query: `psql -c "select * from live_introspection_requests where id = '${l.id}'"`,
    }));
  }
  for (const s of sessions) {
    obs.push(observation({
      id: eventId("ev", "live.db_client_session", s.source_id),
      fact: "live.client_presence", source: "db", origin: origin.measured("db"),
      subject: { tenant, episode, participant: s.participant_id, attempt: s.source_id },
      window: { from_ms: ms(s.first_received_at) ?? readMs, to_ms: readMs },
      claim: String(s.source_id),
      value: { client_session_id: s.source_id, ...(s.sdk_version ? { sdk_version: s.sdk_version } : {}) },
      failure: false, query: `psql -c "select * from telemetry_sources where source_id = '${s.source_id}'"`,
    }));
  }
  return obs;
}
