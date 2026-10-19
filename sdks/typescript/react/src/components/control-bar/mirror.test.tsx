// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient } from "../../test-support/preview-client";
import { ParticipantTileSurface } from "../participant-tile/ParticipantTile";
import { useConnectedControlBarBehavior, type ControlBarProps } from "./control-bar-behavior";

function MirrorControl(props: ControlBarProps) {
  const { surfaceProps } = useConnectedControlBarBehavior(props);
  return (
    <button type="button" aria-pressed={surfaceProps.mirrored} onClick={() => surfaceProps.onMirrorChange?.(!surfaceProps.mirrored)}>
      Mirror
    </button>
  );
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());

it("persists a connected mirror toggle and updates only default local tiles without media commands", async () => {
  const onCommand = vi.fn();
  const client = createPreviewClient(undefined, { onCommand });
  const container = document.createElement("div");
  const root = createRoot(container);
  const mirrored = (id: string) => container.querySelector(`[data-camera="${id}"]`)?.parentElement?.classList.contains("scale-x-[-1]");
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <MirrorControl />
          <ParticipantTileSurface participant={{ id: "self", displayName: "You", isLocal: true }} media={<video data-camera="self" />} mediaVisible />
          <ParticipantTileSurface participant={{ id: "remote", displayName: "Nora" }} media={<video data-camera="remote" />} mediaVisible />
          <ParticipantTileSurface participant={{ id: "override", displayName: "You", isLocal: true }} mirror={false} media={<video data-camera="override" />} mediaVisible />
        </ChalkProvider>,
      ),
    );
    expect(mirrored("self")).toBe(true);
    expect(mirrored("remote")).toBe(false);
    expect(mirrored("override")).toBe(false);
    await act(async () => container.querySelector("button")?.click());
    expect(localStorage.getItem("chalk_mirror")).toBe("off");
    expect(container.querySelector("button")?.getAttribute("aria-pressed")).toBe("false");
    expect(mirrored("self")).toBe(false);
    expect(mirrored("remote")).toBe(false);
    await act(async () => container.querySelector("button")?.click());
    expect(localStorage.getItem("chalk_mirror")).toBe("on");
    expect(mirrored("self")).toBe(true);
    expect(onCommand).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.dispose();
  }
});

it("respects the controlled value and handler", async () => {
  const client = createPreviewClient();
  const container = document.createElement("div");
  const root = createRoot(container);
  const onMirrorChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <MirrorControl mirrored={false} onMirrorChange={onMirrorChange} />
        </ChalkProvider>,
      ),
    );
    expect(container.querySelector("button")?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => container.querySelector("button")?.click());
    expect(onMirrorChange).toHaveBeenCalledWith(true);
    expect(localStorage.getItem("chalk_mirror")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.dispose();
  }
});
