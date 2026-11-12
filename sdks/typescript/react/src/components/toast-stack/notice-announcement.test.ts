import { createElement } from "react";
import { expect, it } from "vitest";
import { mergeRepeats } from "./notice-announcement";

it("shows a repeated notice once, at its latest place, and keeps every id so one dismissal clears them all", () => {
  const groups = mergeRepeats([
    { id: "a", message: "Couldn’t change your device settings.", type: "error" },
    { id: "b", message: "Nora joined" },
    { id: "c", message: "Couldn’t change your device settings.", type: "error" },
  ]);
  expect(groups.map((group) => [group.notice.id, group.ids])).toEqual([
    ["b", ["b"]],
    ["c", ["a", "c"]],
  ]);
});

it("keeps the same words at different severities apart, and never merges notices it cannot read", () => {
  const Opaque = () => null;
  const groups = mergeRepeats([
    { id: "a", message: "Recording stopped" },
    { id: "b", message: "Recording stopped", type: "error" },
    { id: "c", message: createElement(Opaque) },
    { id: "d", message: createElement(Opaque) },
  ]);
  expect(groups.map((group) => group.notice.id)).toEqual(["a", "b", "c", "d"]);
});
