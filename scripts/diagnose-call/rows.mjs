// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { createHash } from "node:crypto";

/** The hash the API and Sync log for a Participant; the SFU node logs the raw id. */
export function participantHash(participantId) {
  return createHash("sha256").update(participantId).digest("hex");
}

/**
 * Axiom returns a log line twice: nested (`attributes: { event }`, `service: { name }`) and flat (`"attributes.event": null`,
 * `"service.name": null`), and the flat copy is null whenever the field lives in the nested one. A null never overwrites a value.
 */
function flatten(value, prefix = "", into = {}) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, into);
  } else if (value !== null || !(prefix in into)) {
    into[prefix] = value;
  }
  return into;
}

const camel = (name) => name.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase());

/**
 * Reads a field by the last segment of its dotted name, so the same code reads logs (`attributes.x`) and spans
 * (`attributes.custom.x`). The SFU's congestion line still exports camelCase names, so the camelCase spelling is read too.
 */
function field(flat, name) {
  for (const spelling of new Set([name, camel(name)])) {
    for (const key of [spelling, `attributes.${spelling}`, `attributes.custom.${spelling}`]) {
      const value = flat[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

/** An attribute of a normalized row, by its short name. */
export function attr(row, name) {
  return field(row.attrs, name);
}

/** A numeric attribute, or undefined when the row does not carry it. */
export function number(row, name) {
  const value = attr(row, name);
  return value === undefined ? undefined : Number(value);
}

/** Lines logged before the builds that name their event are known by their message. */
const LEGACY_EVENTS = {
  "SDK call stats": "sdk.call_stats",
  "SDK audio receive summary": "sdk.connection_report",
  "SDK connection failure": "sdk.connection_report",
  "media connection replacement": "media.connection_replacement",
};

function eventOf(flat) {
  const event = String(field(flat, "event") ?? LEGACY_EVENTS[flat.body] ?? flat.name ?? flat.body ?? "");
  // Client telemetry logs one row per event; its measured stats windows are the samples this checker has always read as
  // `sdk.call_stats`. A gap window measured nothing, so it is not a sample and cannot stand for client coverage.
  return event === "sdk.telemetry" && field(flat, "type") === "call_stats" && field(flat, "gap") === undefined ? "sdk.call_stats" : event;
}

/** The service that wrote the row: where the API and the node report it, and where a span's resource carries it. */
const serviceOf = (flat) => flat["service.name"] ?? flat["resource.service.name"];

function sourceOf(flat, fallback) {
  const service = serviceOf(flat);
  if (service === "chalk-sfu") return "sfu";
  if (service === "chalk-sync") return "sync";
  if (typeof service === "string" && service.startsWith("chalk-recorder")) return "recorder";
  if (eventOf(flat).startsWith("sdk.")) return "client";
  if (eventOf(flat).startsWith("db.")) return "db";
  return fallback;
}

/**
 * One row of any source in one shape. `participant` is always the hash, so the API's, Sync's and the node's rows compare.
 * `time` is epoch milliseconds. `id` names the row so a finding can point at it: Axiom's `_rowId`, or `db:<table>:<key>`.
 */
export function normalizeRow(data, fallbackSource = "api") {
  const flat = flatten(data);
  const rawParticipant = field(flat, "participant_id");
  const hash = field(flat, "participant_id_hash") ?? (rawParticipant ? participantHash(String(rawParticipant)) : undefined);
  return {
    id: flat._rowId ?? flat.id ?? `row:${createHash("sha1").update(JSON.stringify(data)).digest("hex").slice(0, 12)}`,
    source: sourceOf(flat, fallbackSource),
    time: Date.parse(String(flat._time ?? flat.time)),
    event: eventOf(flat),
    episode: field(flat, "episode_id"),
    participant: hash,
    connection: field(flat, "connection_id") ?? field(flat, "provider_session_id"),
    journey: field(flat, "journey_id"),
    trace: flat.trace_id ?? field(flat, "trace_id"),
    attrs: flat,
  };
}
