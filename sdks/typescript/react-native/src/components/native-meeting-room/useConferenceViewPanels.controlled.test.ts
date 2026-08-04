// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { act, renderHook } from "../../test-renderer";
import { createWhiteboardStoreOption } from "./__tests__/space-view-test-fixtures";

const alert = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock("react-native", () => ({ Alert: alert, Share: { share: vi.fn(async () => undefined) } }));

import { useSpaceViewPanels } from "./useConferenceViewPanels";

describe("controlled Space view state", () => {
  it("updates production panel, sheet, and whiteboard state without remounting the hook", () => {
    const base = {
      canWhiteboard: true,
      isHost: false,
      ...createWhiteboardStoreOption(),
      room: { roomId: "room-id", roomName: null, status: "connected" as const, isConnected: true, isJoining: false, hostId: null },
      telemetry: undefined,
      onLeave: vi.fn(),
      onEndForAll: undefined,
      run: vi.fn(async (action: () => void | Promise<void>) => {
        await action();
      }),
    };
    const { result, rerender } = renderHook(({ state }) => useSpaceViewPanels({ ...base, controlledState: state }), { initialProps: { state: { layout: "grid" as const, panel: null, settingsOpen: false, whiteboardOpen: false } } });

    expect(result.current.layout.layout).toBe("grid");
    expect(result.current.panel).toBeNull();
    expect(result.current.whiteboard.isOpen).toBe(false);

    act(() => rerender({ state: { layout: "presentation", panel: "participants", settingsOpen: true, whiteboardOpen: true } }));

    expect(result.current.layout.layout).toBe("presentation");
    expect(result.current.panel).toBe("participants");
    expect(result.current.settingsOpen).toBe(true);
    expect(result.current.whiteboard.isOpen).toBe(true);
  });
});
