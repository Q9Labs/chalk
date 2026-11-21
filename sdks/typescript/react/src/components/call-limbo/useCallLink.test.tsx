// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useCallLink } from "./useCallLink";

afterEach(() => document.body.replaceChildren());

function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seen: boolean[] = [];
  function Probe({ alone, live }: { readonly alone: boolean; readonly live: boolean }) {
    seen.push(useCallLink(alone, live).open);
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  return { open: () => seen.at(-1), show: (alone: boolean, live: boolean) => act(() => root.render(<Probe alone={alone} live={live} />)) };
}

it("waits for the call to be live before opening the reveal for a host who is alone", () => {
  const link = mount();
  link.show(true, false);
  expect(link.open()).toBe(false);
  link.show(true, true);
  expect(link.open()).toBe(true);
});

it("closes the reveal when someone joins, and never opens it for a call that already has people", () => {
  const alone = mount();
  alone.show(true, true);
  alone.show(false, true);
  expect(alone.open()).toBe(false);

  const crowded = mount();
  crowded.show(false, false);
  crowded.show(false, true);
  expect(crowded.open()).toBe(false);
});

it("keeps the reveal closed while the call is in limbo and brings it back when the call returns", () => {
  const link = mount();
  link.show(true, true);
  link.show(true, false);
  expect(link.open()).toBe(false);
  link.show(true, true);
  expect(link.open()).toBe(true);
});
