import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
}));
vi.mock("../ChalkEmbeddedWhiteboard", () => ({
  ChalkEmbeddedWhiteboard: "ChalkEmbeddedWhiteboard",
}));

import type { NativeMeetingWhiteboardController } from "./useNativeMeetingRoomController";
import { forwardNativeMeetingWhiteboardMetric, shouldRenderNativeMeetingWhiteboard } from "./NativeMeetingWhiteboardSurface";

describe("NativeMeetingWhiteboardSurface", () => {
  it("renders only for an open canonical whiteboard transport", () => {
    expect(shouldRenderNativeMeetingWhiteboard(controller({ isOpen: false, transport: null }))).toBe(false);
    expect(shouldRenderNativeMeetingWhiteboard(controller({ isOpen: true, transport: null }))).toBe(false);
    expect(
      shouldRenderNativeMeetingWhiteboard(
        controller({
          isOpen: true,
          transport: {} as NonNullable<NativeMeetingWhiteboardController["transport"]>,
        }),
      ),
    ).toBe(true);
  });

  it("forwards renderer metrics in production runtimes", () => {
    const onMetric = vi.fn();
    const metric = { name: "whiteboard.frame.delay_ms", value: 17 };

    forwardNativeMeetingWhiteboardMetric(metric, onMetric);

    expect(onMetric).toHaveBeenCalledWith(metric);
  });
});

function controller(overrides: Partial<NativeMeetingWhiteboardController>): NativeMeetingWhiteboardController {
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
