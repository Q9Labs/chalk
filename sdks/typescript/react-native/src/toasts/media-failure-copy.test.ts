import { SpaceClientError } from "@q9labsai/chalk-client";
import { expect, it } from "vitest";
import { describeMediaFailure } from "./media-failure-copy";

it("names every error in the chain and the top of the innermost stack", () => {
  const inner = new TypeError("transceiver.stop is not a function");
  const outer = new Error("pause failed", { cause: inner });
  const text = describeMediaFailure(outer);
  expect(text).toContain("Error: pause failed");
  expect(text).toContain("TypeError: transceiver.stop is not a function");
  expect(text).toContain("media-failure-copy.test.ts");
});

it("shows the SDK error code", () => {
  const error = new SpaceClientError({ code: "media.capture_failed", recoverable: true, message: "pause failed" });
  expect(describeMediaFailure(error)).toContain("SpaceClientError [media.capture_failed]: pause failed");
});

it("prints a thrown non-error value", () => {
  expect(describeMediaFailure("boom")).toBe("  boom");
});
