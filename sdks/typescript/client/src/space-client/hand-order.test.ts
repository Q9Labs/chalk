import { expect, it } from "vitest";
import { nextHandOrder } from "./hand-order";

it("keeps hands in the order they went up and drops lowered ones", () => {
  const first = nextHandOrder([], ["b", "a"]);
  expect(first).toEqual(["b", "a"]);
  expect(nextHandOrder(first, ["a", "b", "c"])).toEqual(["b", "a", "c"]);
  expect(nextHandOrder(["b", "a", "c"], ["c", "a"])).toEqual(["a", "c"]);
});

it("returns the same array when nothing changed", () => {
  const order = ["a", "b"];
  expect(nextHandOrder(order, ["b", "a"])).toBe(order);
});
