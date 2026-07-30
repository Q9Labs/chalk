import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
}));
vi.mock("../ChalkEmbeddedWhiteboard", () => ({
  ChalkEmbeddedWhiteboard: "ChalkEmbeddedWhiteboard",
}));

import type { NativeMeetingWhiteboardController } from "./useNativeMeetingRoomController";
import { shouldRenderNativeMeetingWhiteboard } from "./NativeMeetingWhiteboardSurface";

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
