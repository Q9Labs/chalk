import { describe, expect, it, vi } from "vitest";

const whiteboard = { connect: vi.fn() };

vi.mock("../context/chalk-provider", () => ({
  useChalkSession: () => ({ whiteboard }),
}));

describe("useChalkWhiteboardTransport", () => {
  it("returns the session whiteboard transport", async () => {
    const { useChalkWhiteboardTransport } = await import("./useChalkWhiteboardTransport");

    expect(useChalkWhiteboardTransport()).toBe(whiteboard);
  });

  it("rejects sessions without a whiteboard transport", async () => {
    vi.doMock("../context/chalk-provider", () => ({ useChalkSession: () => ({ whiteboard: undefined }) }));
    vi.resetModules();
    const { useChalkWhiteboardTransport } = await import("./useChalkWhiteboardTransport");

    expect(() => useChalkWhiteboardTransport()).toThrow(/not available/u);
  });
});
