import { describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useEffect: (effect: () => void) => effect(),
  useMemo: <T>(factory: () => T) => factory(),
}));

import { useConferenceViewDiagnostics } from "./useConferenceViewDiagnostics";

describe("useConferenceViewDiagnostics", () => {
  it("projects the room diagnostic snapshot and reports it to the consumer", () => {
    const onDiagnosticsChange = vi.fn();
    const result = useConferenceViewDiagnostics({
      capabilities: {
        canChat: true,
        canParticipants: true,
        canScreenShare: true,
        canReactions: true,
        canHandRaise: true,
        canWhiteboard: false,
        isHost: false,
        canModerate: false,
        screenShareAvailability: { enabled: true, reason: null, detail: null },
      },
      participants: { participantCount: 3 },
      chat: { unreadCount: 2 },
      interactions: { raisedHandCount: 1 },
      screenShare: { isActive: true, isLocalSharing: false, sharerParticipantId: "participant-2" },
      onDiagnosticsChange,
    });

    expect(result.roomDiagnostics).toMatchObject({ participantCount: 3, raisedHandCount: 1, unreadChatCount: 2, isHost: false });
    expect(onDiagnosticsChange).toHaveBeenCalledWith(result.roomDiagnostics);
  });
});
