import { describe, expect, it } from "vitest";
import vectors from "../../../../../observability/registry/vectors.json";
import { canonicalFlags, flagsHash } from "./flags.ts";
import { diagnosticCode, formatHandle, parseHandle, resolveHandle, type HandleTarget } from "./ids.ts";
import { ID_KINDS, type FlagMap, type FlagValue, type IdKind } from "./registry.ts";

const isIdKind = (kind: string): kind is IdKind => ID_KINDS.some((entry) => entry.kind === kind);

function idKind(kind: string): IdKind {
  if (!isIdKind(kind)) throw new Error(`vector names unknown kind ${kind}`);
  return kind;
}

const isFlagValue = (value: unknown): value is FlagValue => value === null || ["string", "number", "boolean"].includes(typeof value);
const flagMap = (value: object): FlagMap => Object.fromEntries(Object.entries(value).filter((entry): entry is [string, FlagValue] => isFlagValue(entry[1])));

const targets = (candidates: readonly { readonly kind: string; readonly id: string; readonly legacyHash?: string }[]): HandleTarget[] => candidates.map((candidate) => ({ ...candidate, kind: idKind(candidate.kind) }));

describe("handles agree with the cross-language vectors", () => {
  it.each(vectors.format)("formats $kind $id", (vector) => {
    const run = () => formatHandle(idKind(vector.kind), vector.id, "scope" in vector ? { scope: vector.scope } : undefined);
    if ("error" in vector) expect(run).toThrow();
    else expect(run()).toBe(vector.expect);
  });

  it.each(vectors.parse)("parses $text", (vector) => {
    const parsed = parseHandle(vector.text);
    expect(parsed).toEqual("error" in vector ? { ok: false, error: vector.error } : { ok: true, handle: vector.expect });
  });

  it.each(vectors.resolve)("resolves $text without picking one of several matches", (vector) => {
    const parsed = parseHandle(vector.text);
    if (!parsed.ok) throw new Error(`${vector.text} did not parse`);
    expect(resolveHandle(parsed.handle, targets(vector.candidates))).toEqual(vector.expect);
  });

  it.each(vectors.diagnostic_code)("derives the diagnostic code of $id", (vector) => {
    expect(diagnosticCode(vector.id)).toBe(vector.expect);
  });

  it.each(vectors.flags_hash)("hashes flags %#", (vector) => {
    if ("error" in vector) {
      expect(() => flagsHash(flagMap(vector.flags))).toThrow();
      return;
    }
    expect(canonicalFlags(flagMap(vector.flags))).toBe(vector.canonical);
    expect(flagsHash(flagMap(vector.flags))).toBe(vector.expect);
  });
});
