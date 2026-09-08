export function objectValue(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

export function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

export function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) throw new TypeError(`${label} has unexpected fields`);
}

export function stringField(value: object, key: string, label: string, maximum: number): string {
  const candidate = field(value, key);
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > maximum) throw new TypeError(`${label} ${key} is invalid`);
  return candidate;
}

export function patternedStringField(value: object, key: string, pattern: RegExp, label: string, maximum: number): string {
  const candidate = stringField(value, key, label, maximum);
  if (!pattern.test(candidate)) throw new TypeError(`${label} ${key} has an invalid format`);
  return candidate;
}

export function integerField(value: object, key: string, minimum: number, maximum: number, label: string): number {
  const candidate = field(value, key);
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) throw new TypeError(`${label} ${key} is invalid`);
  return candidate;
}

export function literalField<const Value extends string | number>(value: object, key: string, expected: Value, message: string): void {
  if (field(value, key) !== expected) throw new TypeError(message);
}
