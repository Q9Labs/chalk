import { describe, expect, it, vi } from "vitest";

const alert = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: () => undefined,
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(current: T) => ({ current }),
  useState: <T>(initial: T): readonly [T, (next: T) => void] => [initial, vi.fn()],
  useSyncExternalStore: () => ({ canDraw: true, canClear: false }),
}));
vi.mock("react-native", () => ({ Alert: alert, Share: { share: vi.fn(async () => undefined) } }));
vi.mock("../../hooks/useLayout", () => ({
  useLayout: () => ({ layout: "grid", isMobileView: true, isFullscreen: false, setLayout: vi.fn(), toggleLayout: vi.fn(), toggleFullscreen: vi.fn(async () => undefined) }),
}));

import { useConferenceViewPanels } from "./useConferenceViewPanels";

describe("useConferenceViewPanels", () => {
  it("composes layout, panel state, whiteboard state, and leave actions", () => {
    const session = {
      whiteboard: null,
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => ({ whiteboard: { canDraw: true, canClear: false } })),
    };
    const panels = useConferenceViewPanels({
      roomName: "Room",
      meetingLink: "https://example.test/room",
      canWhiteboard: true,
      isHost: true,
      session,
      room: { roomId: "room-id", roomName: null, status: "connected", isConnected: true, isJoining: false, hostId: "host" },
      telemetry: undefined,
      onLeave: vi.fn(),
      onEndForAll: vi.fn(),
      run: vi.fn(async (action) => {
        await action();
      }),
    });

    expect(panels).toMatchObject({ layout: { layout: "grid" }, panel: null, formattedDuration: "0:00", whiteboard: { isOpen: false, canDraw: true } });
    panels.openPanel("participants");
    expect(panels.openPanel).toBeTypeOf("function");
    panels.handleLeave();
    expect(alert.alert).toHaveBeenCalledWith("Leave meeting?", "Choose how you want to leave.", expect.any(Array));
  });
});
