// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Stage } from "./Stage";

it("keeps the local camera tile pinnable when remote tiles follow", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const click = vi.fn();
  try {
    await act(async () => root.render(<Stage items={[{ kind: "participant", id: "self", participant: { id: "self", displayName: "Me", isLocal: true } }]} layout="grid" onItemClick={click} animate={false} generatedAvatars={false} />));
    const tile = container.querySelector('button[aria-label="Video tile for Me"]');
    expect(tile).not.toBeNull();
    if (tile instanceof HTMLButtonElement) await act(async () => tile.click());
    expect(click).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
