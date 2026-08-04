import { afterEach, describe, expect, it, vi } from "vitest";

import { createWhiteboardStoreOption } from "./__tests__/space-view-test-fixtures";

const alert = vi.hoisted(() => ({ alert: vi.fn() }));
const effects = vi.hoisted(() => ({ enabled: false }));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => unknown) => {
    if (effects.enabled) effect();
  },
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(current: T) => ({ current }),
  useState: <T>(initial: T): readonly [T, (next: T) => void] => [initial, vi.fn()],
  useSyncExternalStore: () => ({ canDraw: true, canClear: false }),
}));
vi.mock("react-native", () => ({ Alert: alert, Share: { share: vi.fn(async () => undefined) } }));
vi.mock("../../hooks/useLayout", () => ({
  useLayout: (initialLayout = "grid") => ({ layout: initialLayout, isMobileView: true, isFullscreen: false, setLayout: vi.fn(), toggleLayout: vi.fn(), toggleFullscreen: vi.fn(async () => undefined) }),
}));

import { useSpaceViewPanels } from "./useConferenceViewPanels";

afterEach(() => {
  effects.enabled = false;
  vi.unstubAllGlobals();
});

describe("useConferenceViewPanels", () => {
  it("composes layout, panel state, whiteboard state, and leave actions", () => {
    const panels = useSpaceViewPanels({
      roomName: "Room",
      meetingLink: "https://example.test/room",
      canWhiteboard: true,
      isHost: true,
      ...createWhiteboardStoreOption(),
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
    expect(alert.alert).toHaveBeenCalledWith("Leave Space?", "Choose how you want to leave this live Episode.", expect.any(Array));
  });

  it("seeds the existing native overlays and elapsed duration", () => {
    const panels = useSpaceViewPanels({
      canWhiteboard: true,
      isHost: false,
      ...createWhiteboardStoreOption(),
      room: { roomId: "room-id", roomName: null, status: "connected", isConnected: true, isJoining: false, hostId: null },
      telemetry: undefined,
      onLeave: vi.fn(),
      onEndForAll: undefined,
      run: vi.fn(async (action) => {
        await action();
      }),
      initialState: { layout: "focus", panel: "chat", actionsOpen: true, reactionPickerOpen: true, settingsOpen: true, whiteboardOpen: true, durationSeconds: 42 },
    });

    expect(panels).toMatchObject({ layout: { layout: "focus" }, panel: "chat", actionsOpen: true, reactionPickerOpen: true, settingsOpen: true, secondsElapsed: 42, formattedDuration: "0:42", whiteboard: { isOpen: true } });
  });

  it("opens the existing leave confirmation once when seeded", () => {
    vi.stubGlobal(
      "setInterval",
      vi.fn(() => 1),
    );
    vi.stubGlobal("clearInterval", vi.fn());
    effects.enabled = true;
    alert.alert.mockClear();
    useSpaceViewPanels({
      canWhiteboard: true,
      isHost: false,
      ...createWhiteboardStoreOption(),
      room: { roomId: "room-id", roomName: null, status: "connected", isConnected: true, isJoining: false, hostId: null },
      telemetry: undefined,
      onLeave: vi.fn(),
      onEndForAll: undefined,
      run: vi.fn(async (action) => {
        await action();
      }),
      initialState: { leaveConfirmationOpen: true },
    });

    expect(alert.alert).toHaveBeenCalledWith("Leave Space?", "Choose how you want to leave this live Episode.", expect.any(Array));
  });
});
