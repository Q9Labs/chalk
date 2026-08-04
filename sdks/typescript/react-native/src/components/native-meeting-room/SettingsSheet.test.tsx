import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./SettingsSheet.tsx", import.meta.url), "utf8");

describe("SettingsSheet", () => {
  it("exposes accessible tabs and real device toggles", () => {
    expect(source).toContain('accessibilityRole="tablist"');
    expect(source).toContain('["devices", "appearance", "space"]');
    expect(source).toContain("controller.toggleAudio");
    expect(source).toContain("controller.toggleVideo");
    expect(source).toContain("<AppearanceSettings />");
    expect(source).toContain("StyleSheet.absoluteFillObject");
    expect(source).not.toContain("marginBottom: 94");
    expect(source).not.toContain("bottom: 94");
  });
});
