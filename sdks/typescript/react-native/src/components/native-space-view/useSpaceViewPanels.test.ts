import { describe, expect, it, vi } from "vitest";

const alert = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: () => undefined,
  useMemo: <T>(factory: () => T) => factory(),
  useRef: <T>(current: T) => ({ current }),
  useState: <T>(initial: T): readonly [T, (next: T) => void] => [initial, vi.fn()],
}));
vi.mock("react-native", () => ({ Alert: alert, Share: { share: vi.fn(async () => undefined) } }));
vi.mock("../../hooks/useLayout", () => ({
  useLayout: () => ({ layout: "grid", isMobileView: true, isFullscreen: false, setLayout: vi.fn(), toggleLayout: vi.fn(), toggleFullscreen: vi.fn(async () => undefined) }),
}));

import { useSpaceViewPanels } from "./useSpaceViewPanels";

describe("useSpaceViewPanels", () => {
  it("composes layout, panel state, whiteboard state, and leave actions", () => {
    const panels = useSpaceViewPanels({
      spaceName: "Space",
      inviteLink: "https://example.test/space",
      canWhiteboard: true,
      canDraw: true,
      canClear: false,
      canEndEpisode: true,
      transport: null,
      onLeave: vi.fn(),
      onEndEpisode: vi.fn(),
      run: vi.fn(async (action) => {
        await action();
      }),
    });

    expect(panels).toMatchObject({ layout: { layout: "grid" }, panel: null, formattedDuration: "0:00", whiteboard: { isOpen: false, canDraw: true } });
    panels.openPanel("participants");
    expect(panels.openPanel).toBeTypeOf("function");
    panels.handleLeave();
    expect(alert.alert).toHaveBeenCalledWith("Leave Space?", "Choose how you want to leave.", expect.any(Array));
  });
});
