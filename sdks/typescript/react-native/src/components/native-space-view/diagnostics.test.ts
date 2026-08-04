import { describe, expect, it } from "vitest";

import { buildSpaceViewDiagnosticsSnapshot } from "./diagnostics";

describe("buildSpaceViewDiagnosticsSnapshot", () => {
  it("surfaces canonical feature and moderation availability", () => {
    const snapshot = buildSpaceViewDiagnosticsSnapshot({
      featureFlags: {
        chat: true,
        participants: true,
        screenShare: false,
        reactions: true,
        handRaise: true,
        whiteboard: true,
      },
      canEndEpisode: false,
      participantCount: 2,
      raisedHandCount: 0,
      unreadChatCount: 0,
      isScreenShareActive: false,
      isLocalScreenSharing: false,
      screenShareSharerParticipantId: null,
    });

    expect(snapshot.actionAvailability.screenShare).toMatchObject({
      enabled: false,
      reason: "feature-disabled",
    });
    expect(snapshot.actionAvailability.moderation.reason).toBe("capability-unavailable");
  });
});
