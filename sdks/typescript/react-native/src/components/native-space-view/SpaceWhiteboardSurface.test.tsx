import { describe, expect, it, vi } from "vitest";

const nativeTheme = vi.hoisted(() => ({ colorScheme: "light" as "light" | "dark" }));

vi.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
}));
vi.mock("../../ui/native-theme", () => ({
  useNativeTheme: () => nativeTheme,
}));
vi.mock("../EmbeddedWhiteboard", () => ({
  EmbeddedWhiteboard: "EmbeddedWhiteboard",
}));

import type { SpaceWhiteboardState } from "./useSpaceViewPanels";
import { forwardNativeSpaceWhiteboardFailure, forwardNativeSpaceWhiteboardMetric, shouldRenderNativeSpaceWhiteboard, SpaceWhiteboardSurface } from "./SpaceWhiteboardSurface";

describe("SpaceWhiteboardSurface", () => {
  it("renders only for an open canonical whiteboard transport", () => {
    expect(shouldRenderNativeSpaceWhiteboard(controller({ isOpen: false, transport: null }))).toBe(false);
    expect(shouldRenderNativeSpaceWhiteboard(controller({ isOpen: true, transport: null }))).toBe(false);
    expect(
      shouldRenderNativeSpaceWhiteboard(
        controller({
          isOpen: true,
          transport: {} as NonNullable<SpaceWhiteboardState["transport"]>,
        }),
      ),
    ).toBe(true);
  });

  it("forwards renderer metrics in production runtimes", () => {
    const onMetric = vi.fn();
    const metric = { name: "whiteboard.frame.delay_ms", value: 17 };

    forwardNativeSpaceWhiteboardMetric(metric, onMetric);

    expect(onMetric).toHaveBeenCalledWith(metric);
  });

  it("forwards renderer failures without relying on development logging", () => {
    const onMetric = vi.fn();
    forwardNativeSpaceWhiteboardFailure({ code: "renderer_load_failed", recoverable: true }, onMetric);
    expect(onMetric).toHaveBeenCalledWith({
      name: "whiteboard.renderer.failure",
      value: 1,
      attributes: { code: "renderer_load_failed", recoverable: true },
    });

    const element = SpaceWhiteboardSurface({ whiteboard: controller({ isOpen: true, transport: {} as NonNullable<SpaceWhiteboardState["transport"]>, onMetric }) });
    element?.props.onError({ code: "renderer_stopped", message: "renderer stopped", recoverable: true });
    expect(onMetric).toHaveBeenCalledTimes(2);
  });

  it("passes the active NativeTheme color scheme to the embedded renderer", () => {
    nativeTheme.colorScheme = "light";
    const lightElement = SpaceWhiteboardSurface({ whiteboard: controller({ isOpen: true, transport: {} as NonNullable<SpaceWhiteboardState["transport"]> }) });
    expect(lightElement).toMatchObject({ props: { theme: "light" } });

    nativeTheme.colorScheme = "dark";
    const darkElement = SpaceWhiteboardSurface({ whiteboard: controller({ isOpen: true, transport: {} as NonNullable<SpaceWhiteboardState["transport"]> }) });
    expect(darkElement).toMatchObject({ props: { theme: "dark" } });
  });
});

function controller(overrides: Partial<SpaceWhiteboardState>): SpaceWhiteboardState {
  return {
    isOpen: false,
    canDraw: false,
    canClear: false,
    elements: [],
    openParticipants: [],
    transport: null,
    journeyId: "journey-test",
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    requestSync: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  };
}
