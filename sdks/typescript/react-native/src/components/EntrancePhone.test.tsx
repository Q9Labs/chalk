import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./EntrancePhone.tsx", import.meta.url), "utf8");

describe("EntrancePhone", () => {
  it("preserves the Entrance identity and accessible media controls", () => {
    expect(source).toContain(">Entrance<");
    expect(source).toContain('"Join Space"');
    expect(source).toContain('accessibilityLabel={`${label} ${enabled ? "on" : "off"}`}');
  });
});
