import { DIAGNOSTIC_CODE, ID_KINDS, SESSION_MEANINGS, type IdKind } from "./registry.ts";

// Handles are display and lookup syntax only. Stores keep the canonical value: a dashed UUID, a W3C trace or
// span id, or a provider token. formatHandle adds the prefix; parseHandle strips it and says what the text can mean.

export type Candidate = { readonly kind: IdKind; readonly id: string };

export type Handle =
  | { readonly form: "full"; readonly kind: IdKind; readonly id: string }
  | { readonly form: "short"; readonly kind: IdKind; readonly prefix: string }
  | { readonly form: "bare"; readonly candidates: readonly Candidate[] }
  | { readonly form: "session"; readonly candidates: readonly Candidate[] }
  | { readonly form: "legacy_hash"; readonly kind: IdKind; readonly hash: string }
  | { readonly form: "diagnostic_code"; readonly code: string };

export type HandleError = "empty" | "unrecognized" | "unknown_prefix" | "bad_value" | "too_short" | "too_long" | "bad_diagnostic_code";

export type ParsedHandle = { readonly ok: true; readonly handle: Handle } | { readonly ok: false; readonly error: HandleError };

// A row the reader can match a handle against. legacyHash is the participant_id_hash an old row carried.
export type HandleTarget = Candidate & { readonly legacyHash?: string };

export type Resolution = { readonly status: "unique"; readonly match: Candidate } | { readonly status: "ambiguous"; readonly matches: readonly Candidate[] } | { readonly status: "none" };

type IdKindSpec = (typeof ID_KINDS)[number];

const MIN_SHORT = 4;
const HEX = /^[0-9a-f]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_LENGTH = { uuid: 32, hex32: 32, hex16: 16 } as const;

function spec(kind: IdKind): IdKindSpec {
  const found = ID_KINDS.find((entry) => entry.kind === kind);
  if (!found) throw new RangeError(`unknown id kind ${kind}`);
  return found;
}

const dashed = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

// The hex digits of a canonical value, or undefined when it is not one.
function hexOf(entry: IdKindSpec, id: string): string | undefined {
  if (entry.canonical === "token") return undefined;
  const lower = id.toLowerCase();
  const hex = entry.canonical === "uuid" && UUID.test(lower) ? lower.replaceAll("-", "") : lower;
  return HEX.test(hex) && hex.length === HEX_LENGTH[entry.canonical] ? hex : undefined;
}

function stored(entry: IdKindSpec, hex: string): string {
  return entry.canonical === "uuid" ? dashed(hex) : hex;
}

// The canonical stored form of an id, so two spellings of one id compare equal.
export function canonicalId(kind: IdKind, id: string): string {
  const entry = spec(kind);
  if (entry.canonical === "token") return id;
  const hex = hexOf(entry, id);
  if (hex === undefined) throw new RangeError(`${id} is not a canonical ${kind} id`);
  return stored(entry, hex);
}

// The full handle, or with a scope the shortest prefix of at least four hex digits no other id in the scope shares.
export function formatHandle(kind: IdKind, id: string, options?: { readonly scope?: readonly string[] }): string {
  const entry = spec(kind);
  if (entry.canonical === "token") {
    if (id.length === 0 || /\s/.test(id)) throw new RangeError(`${kind} token must be non-empty without whitespace`);
    return `${entry.prefix}_${id}`;
  }
  const hex = hexOf(entry, id);
  if (hex === undefined) throw new RangeError(`${id} is not a canonical ${kind} id`);
  if (!options?.scope) return `${entry.prefix}_${hex}`;
  const others = options.scope.map((other) => hexOf(entry, other)).filter((other): other is string => other !== undefined && other !== hex);
  let length = MIN_SHORT;
  while (length < hex.length && others.some((other) => other.startsWith(hex.slice(0, length)))) length++;
  return `${entry.prefix}_${hex.slice(0, length)}`;
}

// CHK-XXXX: four Crockford base32 characters from the first 20 bits of a client session id.
export function diagnosticCode(clientSessionId: string): string {
  const hex = canonicalId("client_session", clientSessionId).replaceAll("-", "");
  const bits = Number.parseInt(hex.slice(0, 5), 16);
  let code = "";
  for (let index = DIAGNOSTIC_CODE.length - 1; index >= 0; index--) code += DIAGNOSTIC_CODE.alphabet.charAt((bits >> (index * 5)) & 31);
  return `${DIAGNOSTIC_CODE.prefix}${code}`;
}

function parseDiagnosticCode(rest: string): ParsedHandle {
  const normalized = rest.toUpperCase().replaceAll("O", "0").replaceAll("I", "1").replaceAll("L", "1");
  if (normalized.length !== DIAGNOSTIC_CODE.length || ![...normalized].every((char) => DIAGNOSTIC_CODE.alphabet.includes(char))) return { ok: false, error: "bad_diagnostic_code" };
  return { ok: true, handle: { form: "diagnostic_code", code: `${DIAGNOSTIC_CODE.prefix}${normalized}` } };
}

function bareCandidates(text: string): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const entry of ID_KINDS) {
    const hex = hexOf(entry, text);
    if (hex !== undefined) candidates.push({ kind: entry.kind, id: stored(entry, hex) });
  }
  return candidates;
}

export function parseHandle(input: string): ParsedHandle {
  const text = input.trim();
  if (text.length === 0) return { ok: false, error: "empty" };
  const lower = text.toLowerCase();
  if (lower.startsWith(DIAGNOSTIC_CODE.prefix.toLowerCase())) return parseDiagnosticCode(text.slice(DIAGNOSTIC_CODE.prefix.length));
  if (lower.startsWith("session:")) {
    const id = text.slice("session:".length);
    if (id.length === 0) return { ok: false, error: "empty" };
    const candidates = SESSION_MEANINGS.flatMap((meaning): Candidate[] => {
      if (!meaning.lookup || meaning.kind === null) return [];
      const entry = spec(meaning.kind);
      if (entry.canonical === "token") return [{ kind: entry.kind, id }];
      const hex = hexOf(entry, id);
      return hex === undefined ? [] : [{ kind: entry.kind, id: stored(entry, hex) }];
    });
    return { ok: true, handle: { form: "session", candidates } };
  }
  if (/^[0-9a-f]{64}$/.test(lower)) {
    const owner = ID_KINDS.find((entry) => entry.legacyHashField !== null);
    if (owner) return { ok: true, handle: { form: "legacy_hash", kind: owner.kind, hash: lower } };
  }
  const separator = text.indexOf("_");
  if (separator <= 0) {
    const candidates = bareCandidates(text);
    return candidates.length > 0 ? { ok: true, handle: { form: "bare", candidates } } : { ok: false, error: "unrecognized" };
  }
  const entry = ID_KINDS.find((candidate) => candidate.prefix === lower.slice(0, separator));
  if (!entry) return { ok: false, error: "unknown_prefix" };
  const rest = text.slice(separator + 1);
  if (entry.canonical === "token") return rest.length > 0 && !/\s/.test(rest) ? { ok: true, handle: { form: "full", kind: entry.kind, id: rest } } : { ok: false, error: "bad_value" };
  const hex = rest.toLowerCase().replaceAll("-", "");
  const full = HEX_LENGTH[entry.canonical];
  if (!HEX.test(hex)) return { ok: false, error: "bad_value" };
  if (hex.length > full) return { ok: false, error: "too_long" };
  if (hex.length === full) return { ok: true, handle: { form: "full", kind: entry.kind, id: stored(entry, hex) } };
  if (hex.length < MIN_SHORT) return { ok: false, error: "too_short" };
  return { ok: true, handle: { form: "short", kind: entry.kind, prefix: hex } };
}

function tryCanonical(kind: IdKind, id: string): string | undefined {
  const entry = spec(kind);
  if (entry.canonical === "token") return id.length > 0 ? id : undefined;
  const hex = hexOf(entry, id);
  return hex === undefined ? undefined : stored(entry, hex);
}

function matches(handle: Handle, target: Candidate & { readonly legacyHash?: string }): boolean {
  switch (handle.form) {
    case "full":
      return handle.kind === target.kind && handle.id === target.id;
    case "short":
      return handle.kind === target.kind && target.id.replaceAll("-", "").startsWith(handle.prefix);
    case "bare":
    case "session":
      return handle.candidates.some((candidate) => candidate.kind === target.kind && candidate.id === target.id);
    case "legacy_hash":
      return handle.kind === target.kind && target.legacyHash?.toLowerCase() === handle.hash;
    case "diagnostic_code":
      return target.kind === "client_session" && diagnosticCode(target.id) === handle.code;
  }
}

// Matches a parsed handle against rows in a scope. A short handle or CHK code that fits several rows returns all
// of them: the reader never picks one silently.
export function resolveHandle(handle: Handle, targets: readonly HandleTarget[]): Resolution {
  const found = new Map<string, Candidate>();
  for (const target of targets) {
    const id = tryCanonical(target.kind, target.id);
    if (id === undefined) continue;
    const candidate = { kind: target.kind, id };
    if (matches(handle, { ...candidate, ...(target.legacyHash === undefined ? {} : { legacyHash: target.legacyHash }) })) found.set(`${candidate.kind}:${id}`, candidate);
  }
  const all = [...found.values()];
  const [first] = all;
  if (!first) return { status: "none" };
  return all.length === 1 ? { status: "unique", match: first } : { status: "ambiguous", matches: all };
}
