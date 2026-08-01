import { describe, expect, it, vi } from "vitest";

const session = {
  sendReaction: vi.fn(async () => ({ reaction: "🎉" as const })),
};

vi.mock("react", () => ({
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../context/chalk-provider", () => ({
  useChalkSession: () => session,
}));

describe("useChalkActions", () => {
  it("delegates actions to the session store", async () => {
    const { useChalkActions } = await import("./useChalkActions");

    await useChalkActions().sendReaction("🎉");

    expect(session.sendReaction).toHaveBeenCalledWith("🎉");
  });
});
