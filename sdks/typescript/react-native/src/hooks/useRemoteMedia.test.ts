import type { ChalkRemoteMedia, ChalkSessionSnapshot } from "@q9labsai/chalk-client";
import { describe, expect, it, vi } from "vitest";

const remoteMedia = [] as readonly ChalkRemoteMedia[];

vi.mock("./useChalkSelector", () => ({
  useChalkSelector: (selector: (value: ChalkSessionSnapshot) => unknown) => selector({ remoteMedia } as ChalkSessionSnapshot),
}));

describe("useRemoteMedia", () => {
  it("reads remote media from the canonical snapshot", async () => {
    const { useRemoteMedia } = await import("./useRemoteMedia");

    expect(useRemoteMedia()).toBe(remoteMedia);
  });
});
