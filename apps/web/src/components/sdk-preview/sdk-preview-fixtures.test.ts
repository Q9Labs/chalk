import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";
import { chatPending, panelFor, participantsForCount, productionPalette, productionTexture, statusOverlay } from "./sdk-preview-fixtures";

describe("SDK preview fixtures", () => {
  it("maps Participant count and local media controls", () => {
    const participants = participantsForCount(2, { ...DEFAULT_PREVIEW_SEARCH, mic: false, camera: false, hand: true });

    expect(participants).toHaveLength(2);
    expect(participants[0]).toMatchObject({ isMuted: true, isVideoEnabled: false, isHandRaised: true });
  });

  it("projects pending and failed chat messages", () => {
    expect(chatPending({ ...DEFAULT_PREVIEW_SEARCH, chat: "pending" })).toMatchObject([{ state: "sending" }]);
    expect(chatPending({ ...DEFAULT_PREVIEW_SEARCH, chat: "failure" })).toMatchObject([{ state: "failed", error: { code: "internal_error", recoverable: true } }]);
    expect(chatPending(DEFAULT_PREVIEW_SEARCH)).toEqual([]);
  });

  it("maps panels and appearance values to production props", () => {
    expect(panelFor(DEFAULT_PREVIEW_SEARCH)).toBeNull();
    expect(panelFor({ ...DEFAULT_PREVIEW_SEARCH, panel: "admission" })).toBe("admission");
    expect(productionPalette("midnight")).toBe("oled-signal");
    expect(productionTexture("soft-dots")).toBe("slate");
  });

  it("creates actionable recovery states", () => {
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const overlay = statusOverlay({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "timeout" }, onRetry, onBack);

    expect(overlay).toMatchObject({ isVisible: true, status: "failed", supportCode: "space-timeout-408", onRetry, onLeave: onBack });
  });
});
