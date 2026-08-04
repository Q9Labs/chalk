import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const androidSource = readFileSync(new URL("./EndScreen.android.tsx", import.meta.url), "utf8");
const macosSource = readFileSync(new URL("./EndScreen.macos.tsx", import.meta.url), "utf8");

vi.mock("../platform/platform", () => ({ resolvePlatformVariant: () => "android" }));
vi.mock("./EndScreen.android", () => ({ EndScreenAndroid: () => null }));
vi.mock("./EndScreen.ios-pad", () => ({ EndScreenIosPad: () => null }));
vi.mock("./EndScreen.ios-phone", () => ({ EndScreenIosPhone: () => null }));
vi.mock("./EndScreen.macos", () => ({ EndScreenMacos: () => null }));

describe("EndScreen", () => {
  it("selects the platform-specific end screen", async () => {
    const { EndScreen } = await import("./EndScreen");

    expect(EndScreen({ data: { roomId: "room", roomName: "Room", durationSeconds: 1, participantCount: 1, chatCount: 0 }, onGoHome: vi.fn(), onRejoin: vi.fn() })).toBeTruthy();
  });

  it("keeps ended-state actions and headings accessible on native variants", () => {
    for (const source of [androidSource, macosSource]) {
      expect(source).toContain('accessibilityRole="header"');
      expect(source).toContain('accessibilityRole="button"');
      expect(source).toContain('accessibilityLabel="Back to Home"');
    }
    expect(androidSource).toContain('accessibilityLabel="Return to Space"');
    expect(macosSource).toContain('accessibilityLabel="Rejoin Space"');
  });
});
