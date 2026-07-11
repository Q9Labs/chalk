import type { TelemetryAttributes, TelemetryAttributeValue } from "./types";

const MAX_ATTRIBUTE_COUNT = 24;
const MAX_ATTRIBUTE_KEY_LENGTH = 64;
const MAX_ATTRIBUTE_VALUE_LENGTH = 256;

export function normalizeTelemetryAttributes(attributes: TelemetryAttributes | undefined): TelemetryAttributes | undefined {
  if (!attributes) return undefined;
  const entries = Object.entries(attributes).filter(validAttributeEntry).slice(0, MAX_ATTRIBUTE_COUNT).map(normalizeAttributeEntry);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function validAttributeEntry(entry: [string, unknown]): entry is [string, TelemetryAttributeValue] {
  const [key, value] = entry;
  return key.length > 0 && key.length <= MAX_ATTRIBUTE_KEY_LENGTH && isTelemetryAttributeValue(value);
}

function isTelemetryAttributeValue(value: unknown): value is boolean | number | string {
  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "string";
}

function normalizeAttributeEntry([key, value]: [string, TelemetryAttributeValue]): [string, TelemetryAttributeValue] {
  return [key, typeof value === "string" ? value.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH) : value];
}
