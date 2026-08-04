import { describe, expect, it, vi } from "vitest";

const directClient = vi.hoisted(() => ({
  chat: { files: { url: vi.fn(() => "https://example.test/file") }, loadOlder: vi.fn(async () => ({ status: "loaded" })), markRead: vi.fn(async () => null), send: vi.fn(async () => ({})) },
  media: {
    acceptRequest: vi.fn(async () => undefined),
    declineRequest: vi.fn(async () => undefined),
    setCameraEnabled: vi.fn(async () => undefined),
    setMicrophoneEnabled: vi.fn(async () => undefined),
    setScreenShareEnabled: vi.fn(async () => undefined),
  },
  participants: {
    admit: vi.fn(async () => undefined),
    assignRole: vi.fn(async () => undefined),
    deny: vi.fn(async () => undefined),
    lowerHand: vi.fn(async () => undefined),
    mute: vi.fn(async () => undefined),
    raiseHand: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    renameSelf: vi.fn(async () => undefined),
    requestMedia: vi.fn(async () => ({ status: "delivered" })),
    stopScreenShare: vi.fn(async () => undefined),
    stopVideo: vi.fn(async () => undefined),
  },
  reactions: { send: vi.fn(async () => ({})) },
  whiteboard: { transport: vi.fn(() => null) },
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: () => undefined,
  useMemo: <T>(factory: () => T) => factory(),
  useState: <T>(initial: T): readonly [T, (next: T) => void] => [initial, vi.fn()],
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn(async () => undefined) } }));
vi.mock("../../context/space-client-context", () => ({ useSpaceClient: () => directClient }));
vi.mock("../../hooks/space-hooks", () => ({
  useSelf: () => ({ participantId: "self", displayName: "Taylor", handRaised: false, can: (capability: string) => capability !== "endEpisode" }),
  useParticipants: () => ({
    roster: [
      {
        participantId: "self",
        displayName: "Taylor",
        role: "collaborator",
        eligibleRoles: [],
        capabilities: [],
        handRaised: false,
        media: { microphone: "active", camera: "active", screenShare: "inactive" },
      },
    ],
    admissionQueue: [],
  }),
  useMedia: () => ({
    local: {
      microphone: { state: "enabled", track: null },
      camera: { state: "enabled", track: null },
      screen: { state: "disabled", track: null },
    },
    screenShare: { state: "disabled", track: null },
    remote: [],
    incomingRequests: [],
  }),
  useChat: () => ({ status: "ready", messages: [], pendingSends: [], readReceipts: [], unreadCount: 0, pagination: { cursor: null, hasOlder: false, historyTruncated: false } }),
  useReactions: () => ({ active: [] }),
  useWhiteboard: () => ({ engine: { status: "ready", sceneId: null, revision: null, error: null } }),
}));
vi.mock("../../utils/ios-simulator", () => ({ isIosSimulator: () => false }));
vi.mock("./useSpaceViewPanels", () => ({
  useSpaceViewPanels: () => ({
    layout: { layout: "grid" },
    panel: null,
    secondsElapsed: 5,
    formattedDuration: "0:05",
    actionsOpen: false,
    reactionPickerOpen: false,
    whiteboard: { isOpen: false, canDraw: true, canClear: false, elements: [], openParticipants: [], transport: null },
    handleLeave: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    handleInviteParticipants: vi.fn(),
  }),
}));
vi.mock("./useSpaceViewDerived", () => ({ useSpaceViewDerived: () => ({ isStageMode: false, gridPages: [], allParticipants: [] }) }));

import { useSpaceViewController } from "./useSpaceViewController";

describe("useSpaceViewController", () => {
  it("binds native Space actions directly to the canonical SpaceClient", async () => {
    const controller = useSpaceViewController({ spaceName: "Design review", onLeave: vi.fn() });

    expect(controller.participants.localParticipant?.displayName).toBe("Taylor");
    expect(controller.chat.isEnabled).toBe(true);
    expect(controller.canSettings).toBe(true);
    expect(controller.canInvite).toBe(false);
    controller.toggleAudio();
    controller.sendReaction("🎉");
    controller.requestStartParticipantCamera("participant-2");

    await vi.waitFor(() => {
      expect(directClient.media.setMicrophoneEnabled).toHaveBeenCalledWith(false);
      expect(directClient.reactions.send).toHaveBeenCalledWith("🎉");
      expect(directClient.participants.requestMedia).toHaveBeenCalledWith("participant-2", "camera");
    });
  });
});
