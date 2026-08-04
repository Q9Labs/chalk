import type { ChalkLocalMedia, ChalkMediaSource, ChalkSessionSnapshot } from "../client-compat";
import { describe, expect, it, vi } from "vitest";

const localMedia = {} as Readonly<Record<ChalkMediaSource, ChalkLocalMedia>>;

vi.mock("./useChalkSelector", () => ({
  useChalkSelector: (selector: (value: ChalkSessionSnapshot) => unknown) => selector({ localMedia } as ChalkSessionSnapshot),
}));

describe("useLocalMedia", () => {
  it("reads local media from the canonical snapshot", async () => {
    const { useLocalMedia } = await import("./useLocalMedia");

    expect(useLocalMedia()).toBe(localMedia);
  });
});
