// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BoardCursors } from "../../../../../../packages/whiteboard/src/react/board/BoardCursors";

it("does not resurrect an expired retained cursor when the layer remounts", async () => {
  let frame: FrameRequestCallback = () => {};
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  const cursorsRef = { current: new Map([["old", { participantId: "old", displayName: "Former peer", x: 10, y: 20, occurredAt: new Date(Date.now() - 20_000).toISOString() }]]) };
  try {
    await act(async () => root.render(<BoardCursors cursorsRef={cursorsRef} cameraRef={{ current: { scrollX: 0, scrollY: 0, zoom: 1 } }} colorFor={() => "red"} hidden={false} />));
    await act(async () => frame(performance.now()));
    expect(container.querySelector('[data-cursor="old"]')).toBeNull();
    expect(cursorsRef.current.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("refreshes a moving cursor's name and avatar when its participant is renamed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let frame = (_now: number) => {};
  vi.stubGlobal("requestAnimationFrame", (callback: typeof frame) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  const cursor = { participantId: "peer", displayName: "Omar", x: 10, y: 20, occurredAt: new Date().toISOString() };
  const cursorsRef = { current: new Map([["peer", cursor]]) };
  try {
    await act(async () => root.render(<BoardCursors cursorsRef={cursorsRef} cameraRef={{ current: { scrollX: 0, scrollY: 0, zoom: 1 } }} colorFor={() => "red"} hidden={false} />));
    await act(async () => frame(performance.now()));
    expect(container.textContent).toContain("Omar");
    cursorsRef.current.set("peer", { ...cursor, displayName: "Layla", x: 30 });
    await act(async () => frame(performance.now() + 20));
    expect(container.textContent).toContain("Layla");
    expect(container.textContent).not.toContain("Omar");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
