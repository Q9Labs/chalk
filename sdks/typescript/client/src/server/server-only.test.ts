import { describe, expect, it } from "vitest";
import { ChalkServerOnlyError } from "./errors";

describe("server-only entry", () => {
  it("fails during evaluation with the stable guard error", async () => {
    await expect(import("./server-only")).rejects.toEqual(new ChalkServerOnlyError());
  });
});
