import { describe, expect, it } from "vitest";
import { structurallyEqual } from "./structural-equal";

describe("structurallyEqual", () => {
  it("compares arrays and plain objects by content", () => {
    expect(structurallyEqual({ a: [1, { b: 2 }], c: null }, { a: [1, { b: 2 }], c: null })).toBe(true);
    expect(structurallyEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("notices a field that only one side has", () => {
    expect(structurallyEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(structurallyEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false);
  });

  it("compares functions and class instances by identity", () => {
    const can = () => false;
    expect(structurallyEqual({ can }, { can })).toBe(true);
    expect(structurallyEqual({ can }, { can: () => false })).toBe(false);
    expect(structurallyEqual(new Date(0), new Date(0))).toBe(false);
  });
});
