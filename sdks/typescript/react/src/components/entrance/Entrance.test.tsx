// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Entrance } from "./Entrance";

vi.mock("./EntranceSurface", () => ({ EntranceSurface: () => null }));

describe("Entrance preparation", () => {
  it("prepares on open without joining and tolerates unavailable Capture", async () => {
    const onPrepare = vi.fn(async () => {
      throw new Error("Capture unavailable");
    });
    const onJoin = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Entrance spaceName="Design" onPrepare={onPrepare} onJoin={onJoin} defaults={{ microphone: false, camera: false }} />));
      expect(onPrepare).toHaveBeenCalledTimes(1);
      expect(onJoin).not.toHaveBeenCalled();
      await act(async () => root.render(<Entrance spaceName="Design" onPrepare={onPrepare} onJoin={onJoin} defaults={{ microphone: false, camera: false }} />));
      expect(onPrepare).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
