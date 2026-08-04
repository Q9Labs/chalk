import type { TelemetryAttributes, TelemetryAttributeValue } from "./types";

const MAX_ATTRIBUTE_COUNT = 24;
const MAX_ATTRIBUTE_KEY_LENGTH = 64;
const MAX_ATTRIBUTE_VALUE_LENGTH = 256;
const CORRELATION_ATTRIBUTE_KEYS = new Set(["childjourneyid", "rootjourneyid"]);
export const TELEMETRY_BUILT_IN_ATTRIBUTE_KEYS = [
  "journey_kind",
  "category",
  "code",
  "metric_value",
  "child_journey_id",
  "relationship",
  "method",
  "route",
  "duration_ms",
  "status_code",
  "direction",
  "frame_type",
  "connection_state",
  "ice_connection_state",
  "signaling_state",
  "bytes_received",
  "bytes_sent",
  "frames_dropped",
  "inbound_streams",
  "outbound_streams",
  "packets_lost",
  "packets_received",
  "packets_sent",
  "transport_entries",
  "jitter_ms",
  "round_trip_time_ms",
] as const;
const SENSITIVE_IDENTIFIER_ROOTS = [
  "space",
  "episode",
  "participant",
  ["r", "oom"].join(""),
  ["sess", "ion"].join(""),
  ["meet", "ing"].join(""),
  ["con", "ference"].join(""),
  "peer",
  ["att", "endee"].join(""),
  "user",
  "agent",
  "tenant",
  "member",
  "external",
  "connection",
  "provider",
  "publication",
  "stream",
  "track",
  "journey",
  "rootjourney",
] as const;
const SENSITIVE_ATTRIBUTE_KEY_PATTERNS = [
  /(?:access|refresh|id|auth|bearer|csrf|session)?token/u,
  /(?:authorization|cookie|credential|password|secret|privatekey|apikey)/u,
  /(?:body|payload|request|response|sdp|candidate|track|media)(?:content|data)?$/u,
  /(?:displayname|email|phone|username|ipaddress)/u,
  new RegExp(`(?:${SENSITIVE_IDENTIFIER_ROOTS.join("|")})[a-z0-9]*(?:id|ids|identifier|identifiers|slug|key)$`, "u"),
];

export type TelemetryAttributeNormalizationOptions = {
  readonly reservedKeys?: readonly string[];
};

export function normalizeTelemetryAttributes(attributes: TelemetryAttributes | undefined, options: TelemetryAttributeNormalizationOptions = {}): TelemetryAttributes | undefined {
  if (!isAttributeRecord(attributes)) return undefined;
  const entries = Object.entries(attributes)
    .filter(validAttributeEntry)
    .filter(([key]) => !isSensitiveAttributeKey(key));
  const reservedEntries = reservedAttributeEntries(entries, options.reservedKeys ?? []);
  const reservedKeySet = new Set((options.reservedKeys ?? []).map(normalizeAttributeKey));
  const ordinaryEntries = entries.filter(([key]) => !reservedKeySet.has(normalizeAttributeKey(key)));
  const selectedEntries = [...reservedEntries, ...ordinaryEntries].slice(0, MAX_ATTRIBUTE_COUNT);
  const normalizedEntries = selectedEntries.map(([key, value]) => [key, typeof value === "string" ? value.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH) : value]);
  return normalizedEntries.length === 0 ? undefined : Object.fromEntries(normalizedEntries);
}

function validAttributeEntry(entry: [string, unknown]): entry is [string, TelemetryAttributeValue] {
  const [key, value] = entry;
  return key.length > 0 && key.length <= MAX_ATTRIBUTE_KEY_LENGTH && isTelemetryAttributeValue(value);
}

function reservedAttributeEntries(entries: readonly [string, TelemetryAttributeValue][], reservedKeys: readonly string[]): [string, TelemetryAttributeValue][] {
  return reservedKeys.flatMap((reservedKey) => {
    const entry = entries.find(([key]) => key === reservedKey);
    return entry ? [entry] : [];
  });
}

function isSensitiveAttributeKey(key: string): boolean {
  const normalizedKey = normalizeAttributeKey(key);
  return normalizedKey.length === 0 || (!CORRELATION_ATTRIBUTE_KEYS.has(normalizedKey) && SENSITIVE_ATTRIBUTE_KEY_PATTERNS.some((pattern) => pattern.test(normalizedKey)));
}

function normalizeAttributeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function isTelemetryAttributeValue(value: unknown): value is boolean | number | string {
  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "string";
}

function isAttributeRecord(value: unknown): value is TelemetryAttributes {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
