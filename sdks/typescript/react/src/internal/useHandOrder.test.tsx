// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { nextHandOrder, useHandOrder } from "./useHandOrder";

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

it("numbers hands from 1 across renders", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let numbers: ReadonlyMap<string, number> = new Map();
  const Probe = ({ raised }: { readonly raised: readonly string[] }) => {
    numbers = useHandOrder(raised);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe raised={["b"]} />));
  await act(async () => root.render(<Probe raised={["a", "b"]} />));
  expect([...numbers]).toEqual([
    ["b", 1],
    ["a", 2],
  ]);
  await act(async () => root.render(<Probe raised={["a"]} />));
  expect([...numbers]).toEqual([["a", 1]]);
  await act(async () => root.unmount());
});
