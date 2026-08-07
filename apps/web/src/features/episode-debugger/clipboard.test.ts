import { describe, expect, it, vi } from "vitest";
import { selectClipboardFallback, writeClipboardText } from "./clipboard";

describe("writeClipboardText", () => {
  it("copies prepared server text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await expect(writeClipboardText("AgentBrief/v1", { writeText })).resolves.toEqual({
      copied: true,
    });
    expect(writeText).toHaveBeenCalledWith("AgentBrief/v1");
  });

  it("reports unavailable and denied clipboard access", async () => {
    await expect(writeClipboardText("brief", undefined)).resolves.toEqual({
      copied: false,
      reason: "unavailable",
    });
    await expect(writeClipboardText("brief", { writeText: vi.fn().mockRejectedValue(new Error("denied")) })).resolves.toEqual({ copied: false, reason: "denied" });
  });
});

describe("selectClipboardFallback", () => {
  it("focuses and selects the complete fallback text", () => {
    const element = {
      value: "complete brief",
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
    };

    selectClipboardFallback(element);

    expect(element.focus).toHaveBeenCalledOnce();
    expect(element.select).toHaveBeenCalledOnce();
    expect(element.setSelectionRange).toHaveBeenCalledWith(0, 14);
  });
});
