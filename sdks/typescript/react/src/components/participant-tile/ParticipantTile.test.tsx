// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TileShell } from "./TileShell";
import { ParticipantTileSurface } from "./ParticipantTile";

describe("ParticipantTile", () => {
  it("tells the viewer a camera is paused for their network, only while the camera is on", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (participant: { isVideoEnabled: boolean; isVideoPausedForNetwork?: boolean }) => act(async () => root.render(<ParticipantTileSurface participant={{ id: "nora", displayName: "Nora", ...participant }} mediaVisible={false} animatedAvatars={false} />));
    try {
      await render({ isVideoEnabled: true, isVideoPausedForNetwork: true });
      expect(container.querySelector('[data-part="tile-video-paused"]')?.textContent).toBe("Video paused for network");
      await render({ isVideoEnabled: false, isVideoPausedForNetwork: true });
      expect(container.querySelector('[data-part="tile-video-paused"]')).toBeNull();
      await render({ isVideoEnabled: true });
      expect(container.querySelector('[data-part="tile-video-paused"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("shows the participant avatar in the main area when the camera is off", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ParticipantTileSurface participant={{ id: "nora", displayName: "Nora", isVideoEnabled: false }} mediaVisible={false} showName={false} showStatus={false} animatedAvatars={false} />));
      const avatar = container.querySelector('[role="img"][aria-label="Avatar for Nora"]');
      expect(avatar).not.toBeNull();
      expect(avatar?.parentElement?.getAttribute("aria-hidden")).toBe("true");
    } finally {
      await act(async () => root.unmount());
    }
  });
});

it("handles a double click when a focused tile has no single-click action", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onDoubleClick = vi.fn();
  try {
    await act(async () => root.render(<TileShell label="Focused screen" accentColor="white" onDoubleClick={onDoubleClick} />));
    container.querySelector('[role="region"]')?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onDoubleClick).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([false, true])("tile clicks pin without starting Follow, following=%s", async (following) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onClick = vi.fn();
  const onFollow = vi.fn();
  try {
    await act(async () => root.render(<ParticipantTileSurface participant={{ id: "nora", displayName: "Nora", isVideoEnabled: false }} mediaVisible={false} following={following} onFollow={onFollow} onClick={onClick} animatedAvatars={false} />));
    const tile = container.querySelector<HTMLButtonElement>('button[aria-label="Video tile for Nora"]');
    await act(async () => tile?.click());
    expect(onClick).toHaveBeenCalledOnce();
    expect(onFollow).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
