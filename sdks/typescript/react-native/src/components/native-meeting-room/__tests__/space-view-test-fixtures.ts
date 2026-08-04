import { vi } from "vitest";

export function createWhiteboardStoreOption() {
  const snapshot = { whiteboard: { canDraw: true, canClear: false } };
  return {
    session: {
      whiteboard: null,
      subscribe: vi.fn(() => () => undefined),
      getSnapshot: vi.fn(() => snapshot),
    },
  };
}
