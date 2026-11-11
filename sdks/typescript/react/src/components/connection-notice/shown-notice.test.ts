import { expect, it } from "vitest";
import { shownNotice } from "./shown-notice";

it("shows nothing for a good or unknown link", () => {
  expect(shownNotice(undefined, null)).toBeNull();
  expect(shownNotice({ tier: "good" }, null)).toBeNull();
});

it("shows the tier with the reason of a weak link", () => {
  expect(shownNotice({ tier: "weak", reason: "loss" }, null)).toEqual({ tier: "weak", reason: "loss" });
  expect(shownNotice({ tier: "poor" }, null)).toEqual({ tier: "poor" });
});

it("keeps a dismissed chip hidden until the tier gets worse", () => {
  expect(shownNotice({ tier: "weak", reason: "latency" }, "weak")).toBeNull();
  expect(shownNotice({ tier: "poor" }, "weak")).toEqual({ tier: "poor" });
  expect(shownNotice({ tier: "weak", reason: "loss" }, "poor")).toBeNull();
});
