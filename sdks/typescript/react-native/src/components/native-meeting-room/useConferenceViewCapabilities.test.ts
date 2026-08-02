import { describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useMemo: <T>(factory: () => T) => factory(),
}));

import { useConferenceViewCapabilities } from "./useConferenceViewCapabilities";

describe("useConferenceViewCapabilities", () => {
  it("projects feature flags and participant capabilities", () => {
    const result = useConferenceViewCapabilities({
      features: { screenShare: false, whiteboard: false },
      session: { whiteboard: null },
      snapshot: {
        subject: { participantSessionId: "local" },
        participants: [{ participantSessionId: "local", role: "host", capabilities: ["manageAdmission", "removeParticipant"] }],
      },
      chat: { isEnabled: true },
      interactions: { reactionEnabled: true },
    });

    expect(result).toMatchObject({
      isHost: true,
      canChat: true,
      canParticipants: true,
      canScreenShare: false,
      canWhiteboard: false,
      canManageAdmission: true,
      canRemoveParticipants: true,
      canModerate: true,
    });
    expect(result.screenShareAvailability.reason).toBe("feature-disabled");
  });
});
