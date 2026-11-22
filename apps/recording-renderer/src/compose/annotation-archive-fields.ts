import { exactKeys, field, integerField, literalField, objectValue, patternedStringField } from "../validation.js";

export const LABEL = "recording annotation sidecar";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
export const MAXIMUM_TIME = Number.MAX_SAFE_INTEGER;

export function record(value: unknown, keys: readonly string[]): object {
  const result = objectValue(value, LABEL);
  exactKeys(result, keys, LABEL);
  return result;
}

export function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid("has an invalid array");
  return value;
}

export function booleanField(value: object, key: string): boolean {
  const result = field(value, key);
  if (typeof result !== "boolean") throw invalid("has an invalid boolean");
  return result;
}

export function literal(value: object, key: string, expected: string | number): void {
  literalField(value, key, expected, `${LABEL} has a mismatched ${key}`);
}

export function integer(value: object, key: string, minimum: number, maximum = MAXIMUM_TIME): number {
  return integerField(value, key, minimum, maximum, LABEL);
}

export function uuid(value: object, key: string): string {
  return patternedStringField(value, key, UUID, LABEL, 36);
}

export function color(value: object): string {
  return patternedStringField(value, "color", COLOR, LABEL, 7);
}

export function invalid(message: string): TypeError {
  return new TypeError(`${LABEL} ${message}`);
}
