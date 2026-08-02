import type { ChalkSessionSnapshot } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

const snapshot = { state: "live" } as ChalkSessionSnapshot;

vi.mock("./useChalkSelector", () => ({
  useChalkSelector: (selector: (value: ChalkSessionSnapshot) => ChalkSessionSnapshot) => selector(snapshot),
}));

describe("useChalkSnapshot", () => {
  it("returns the canonical session snapshot", async () => {
    const { useChalkSnapshot } = await import("./useChalkSnapshot");

    expect(useChalkSnapshot()).toBe(snapshot);
  });
});
