import { createHash } from "node:crypto";

/** The hash the API and Sync log for a Participant; the SFU node logs the raw id. */
export function participantHash(participantId) {
  return createHash("sha256").update(participantId).digest("hex");
}

function flatten(value, prefix = "", into = {}) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, into);
  } else {
    into[prefix] = value;
  }
  return into;
}

/** Reads a field by the last segment of its dotted name, so the same code reads logs (`attributes.x`) and spans (`attributes.custom.x`). */
function field(flat, name) {
  for (const key of [name, `attributes.${name}`, `attributes.custom.${name}`]) {
    const value = flat[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** An attribute of a normalized row, by its short name. */
export function attr(row, name) {
  return field(row.attrs, name);
}

/** Lines logged before the builds that name their event are known by their message. */
const LEGACY_EVENTS = {
  "SDK call stats": "sdk.call_stats",
  "SDK audio receive summary": "sdk.connection_report",
  "SDK connection failure": "sdk.connection_report",
  "media connection replacement": "media.connection_replacement",
};

function eventOf(flat) {
  return String(field(flat, "event") ?? LEGACY_EVENTS[flat.body] ?? flat.name ?? flat.body ?? "");
}

function sourceOf(flat, fallback) {
  const service = flat["service.name"] ?? flat["resource.service.name"];
  if (service === "chalk-sfu") return "sfu";
  if (service === "chalk-sync") return "sync";
  if (eventOf(flat).startsWith("sdk.")) return "client";
  return fallback;
}

/**
 * One row of any source in one shape. `participant` is always the hash, so the API's, Sync's and the node's rows compare.
 * `time` is epoch milliseconds.
 */
export function normalizeRow(data, fallbackSource = "api") {
  const flat = flatten(data);
  const rawParticipant = field(flat, "participant_id");
  const hash = field(flat, "participant_id_hash") ?? (rawParticipant ? participantHash(String(rawParticipant)) : undefined);
  return {
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
