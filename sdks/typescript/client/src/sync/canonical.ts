const encoder = new TextEncoder();

export type CanonicalJson = null | boolean | number | string | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

export function canonicalJson(value: CanonicalJson): string {
  return serialize(value);
}

export function canonicalJsonBytes(value: CanonicalJson): Uint8Array {
  return canonicalJsonBytesFromUnknown(value);
}

export function canonicalJsonBytesFromUnknown(value: unknown): Uint8Array {
  return encoder.encode(serialize(value));
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (typeof value === "object") return serializeObject(value);
  return serializeScalar(value);
}

function serializeScalar(value: unknown): string {
  switch (typeof value) {
    case "string":
      return serializeString(value);
    case "number":
      return serializeNumber(value);
    case "boolean":
      return JSON.stringify(value);
    default:
      throw new TypeError("canonical JSON only supports JSON values");
  }
}

function serializeString(value: string): string {
  assertWellFormedUnicode(value);
  return JSON.stringify(value);
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("canonical JSON does not support non-finite numbers");
  }
  return JSON.stringify(value);
}

function serializeObject(value: object): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON only supports plain objects");
  const keys = Object.keys(value).sort(compareUnicodeCodeUnits);
  return `{${keys.map((key) => `${serialize(key)}:${serialize(Reflect.get(value, key))}`).join(",")}}`;
}

function compareUnicodeCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isSurrogate(code)) {
      continue;
    }
    const next = value.charCodeAt(index + 1);
    if (isSurrogatePair(code, next)) {
      index += 1;
      continue;
    }
    throw new TypeError("canonical JSON does not support unpaired UTF-16 surrogates");
  }
}

function isSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdfff;
}

function isSurrogatePair(code: number, next: number): boolean {
  return code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}
