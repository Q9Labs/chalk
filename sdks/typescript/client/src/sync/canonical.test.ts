import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical";

describe("canonical JSON", () => {
  it("sorts object keys and rejects values outside JSON", () => {
    expect(canonicalJson({ z: "Zoë", a: "Åsa" })).toBe('{"a":"Åsa","z":"Zoë"}');
    expect(() => canonicalJson({ value: Number.NaN } as never)).toThrow("non-finite");
    expect(() => canonicalJson({ value: "\ud800" } as never)).toThrow("unpaired");
  });
});
