import { describe, expect, it } from "vitest";
import { abortableDelay } from "./controller-utils";

describe("abortableDelay", () => {
  it("rejects immediately with the caller's abort reason", async () => {
    const controller = new AbortController();
    const pending = abortableDelay(60_000, controller.signal);
    controller.abort("controller stopped");

    await expect(pending).rejects.toBe("controller stopped");
  });
});
