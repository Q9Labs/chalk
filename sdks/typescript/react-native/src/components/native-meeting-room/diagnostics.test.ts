import { describe, expect, it } from "vitest";
import { buildNativeMeetingRoomDiagnosticsSnapshot } from "./diagnostics";

describe("buildNativeMeetingRoomDiagnosticsSnapshot", () => {
  it("surfaces the screen-share feature flag disable reason", () => {
    const snapshot = buildNativeMeetingRoomDiagnosticsSnapshot({
      featureFlags: {
        chat: true,
        participants: true,
        transcripts: true,
        settings: true,
        screenShare: false,
        recording: true,
        reactions: true,
        handRaise: true,
        whiteboard: true,
      },
      isHost: false,
      participantCount: 2,
      raisedHandCount: 0,
      unreadChatCount: 0,
      isScreenShareActive: false,
      isLocalScreenSharing: false,
      screenShareSharerParticipantId: null,
    });

    expect(snapshot.actionAvailability.screenShare.enabled).toBe(false);
    expect(snapshot.actionAvailability.screenShare.reason).toBe("feature-disabled");
    expect(snapshot.actionAvailability.screenShare.detail).toContain("features.screenShare=false");
    expect(snapshot.actionAvailability.screenShare.visibleInBottomDock).toBe(false);
    expect(snapshot.actionAvailability.moderation.reason).toBe("not-host");
  });

  it("surfaces custom screen-share unavailability reasons", () => {
    const snapshot = buildNativeMeetingRoomDiagnosticsSnapshot({
      featureFlags: {
        chat: true,
        participants: true,
        transcripts: true,
        settings: true,
        screenShare: true,
        recording: true,
        reactions: true,
        handRaise: true,
        whiteboard: true,
      },
      isHost: true,
      participantCount: 1,
      raisedHandCount: 0,
      unreadChatCount: 0,
      isScreenShareActive: false,
      isLocalScreenSharing: false,
      screenShareSharerParticipantId: null,
      screenShareAvailability: {
        enabled: false,
        reason: "policy-disabled",
        detail: "Screen sharing is restricted by room policy.",
      },
    });

    expect(snapshot.actionAvailability.screenShare.enabled).toBe(false);
    expect(snapshot.actionAvailability.screenShare.reason).toBe("policy-disabled");
    expect(snapshot.actionAvailability.screenShare.detail).toContain("room policy");
    expect(snapshot.actionAvailability.screenShare.enabledInActionsSheet).toBe(false);
  });
});
