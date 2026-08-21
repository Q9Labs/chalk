import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PREVIEW_SEARCH } from "./preview-state";
import { PREVIEW_EPOCH, buildPreviewSnapshot, chatPending, panelFor, participantsForCount, productionPalette, productionTexture, statusOverlay } from "./sdk-preview-fixtures";

describe("SDK preview fixtures", () => {
  it("maps Participant count and local media controls", () => {
    const participants = participantsForCount(2, { ...DEFAULT_PREVIEW_SEARCH, mic: "disabled", camera: "disabled", hand: true });

    expect(participants).toHaveLength(2);
    expect(participants[0]).toMatchObject({ isMuted: true, isVideoEnabled: false, isHandRaised: true });
  });

  it("projects pending and failed chat messages", () => {
    expect(chatPending({ ...DEFAULT_PREVIEW_SEARCH, chat: "pending" })).toMatchObject([{ status: "sending" }]);
    expect(chatPending({ ...DEFAULT_PREVIEW_SEARCH, chat: "failure" })).toMatchObject([{ status: "failed", error: { code: "client.internal_error", recoverable: true } }]);
    expect(chatPending(DEFAULT_PREVIEW_SEARCH)).toEqual([]);
  });

  it("maps panels and appearance values to production props", () => {
    expect(panelFor(DEFAULT_PREVIEW_SEARCH)).toBeNull();
    expect(panelFor({ ...DEFAULT_PREVIEW_SEARCH, panel: "participants" })).toBe("participants");
    expect(productionPalette("cosmic")).toBe("cosmic-chalk");
    expect(productionPalette("midnight")).toBe("oled-signal");
    expect(productionTexture("soft-dots")).toBe("slate");
  });

  it("creates actionable recovery states", () => {
    const onRetry = vi.fn();
    const onBack = vi.fn();
    const overlay = statusOverlay({ ...DEFAULT_PREVIEW_SEARCH, view: "space", state: "timeout" }, onRetry, onBack);

    expect(overlay).toMatchObject({ isVisible: true, status: "failed", supportCode: "space-timeout-408", onRetry, onLeft: onBack });
  });

  it("builds a deterministic snapshot with independent queue, media, and active-speaker state", () => {
    const search = { ...DEFAULT_PREVIEW_SEARCH, view: "space" as const, state: "happy" as const, participants: 2 as const, admissionQueue: "waiting" as const, activeSpeaker: "nora" as const, incomingMediaRequest: "start-camera" as const, camera: "requesting" as const };
    const participants = participantsForCount(search.participants, search);
    const tracks = {
      local: { microphone: null, camera: null, screen: null },
      remote: new Map([["nora", { microphone: null, camera: null, screen: null }]]),
    };

    const first = buildPreviewSnapshot({ participants, search, displayName: "Hasan", episodeDuration: 1122, tracks });
    const second = buildPreviewSnapshot({ participants, search, displayName: "Hasan", episodeDuration: 1122, tracks });

    expect(first.connection.episode?.startedAt).toBe("2026-08-01T09:41:18.000Z");
    expect(first.connection.episode?.startedAt).toBe(second.connection.episode?.startedAt);
    expect(first.participants.admissionQueue[0]?.expiresAt).toBe("2026-08-01T10:01:00.000Z");
    expect(first.participants.roster[1]?.presence.activeSpeaker).toBe(true);
    expect(first.media.incomingRequests[0]?.kind).toBe("start_camera");
    expect(PREVIEW_EPOCH).toBe("2026-08-01T10:00:00.000Z");
  });
});
