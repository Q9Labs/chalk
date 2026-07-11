import { describe, expect, it } from "vitest";
import { normalizeTelemetryAttributes } from "./attributes";

describe("normalizeTelemetryAttributes", () => {
  it("bounds keys, values, and attribute count", () => {
    const attributes = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`key_${index}`, "x".repeat(300)]));
    const normalized = normalizeTelemetryAttributes({ ...attributes, "": "ignored" });

    expect(Object.keys(normalized ?? {})).toHaveLength(24);
    expect(normalized?.key_0).toHaveLength(256);
    expect(Object.hasOwn(normalized ?? {}, "")).toBe(false);
  });
});
