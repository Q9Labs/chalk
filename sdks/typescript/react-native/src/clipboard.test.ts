import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  NativeModules: { ChalkRuntimeInfo: { isSimulator: false } },
  Platform: { OS: "ios" },
}));

describe("clipboard invite suggestion hook", () => {
  it("exposes the extracted clipboard suggestion hook", async () => {
    const { useClipboardInviteSuggestion } = await import("./clipboard");

    expect(typeof useClipboardInviteSuggestion).toBe("function");
  });
});
