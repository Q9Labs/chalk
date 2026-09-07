// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { SkinProvider } from "../skin-context";
import { ControlBar } from "./ControlBar";

describe("compact screen sharing", () => {
  it.each(["classic", "chalk"] as const)("starts and stops screen sharing in the %s skin", async (skin) => {
    const onCommand = vi.fn();
    const client = createPreviewClient(undefined, { onCommand });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <SkinProvider skin={skin}>
            <ChalkProvider client={client}>
              <ControlBar placement="floating" density="compact" buttons={["screenshare"]} />
            </ChalkProvider>
          </SkinProvider>,
        ),
      );
      expect(container.querySelector('[data-tour="controls-screenshare"]')).toBeNull();
      await act(async () => client.setSnapshot(createSnapshot(["publishScreen"])));
      const start = container.querySelector('button[aria-label="Share Screen"]');
      if (!(start instanceof HTMLButtonElement)) throw new Error("Compact screen-share control is missing");
      await act(async () => start.click());
      expect(onCommand).toHaveBeenCalledWith({ type: "setScreenShareEnabled", enabled: true }, expect.anything());
      const stop = container.querySelector('button[aria-label="Stop Share"]');
      if (!(stop instanceof HTMLButtonElement)) throw new Error("Compact stop-sharing control is missing");
      await act(async () => stop.click());
      expect(onCommand).toHaveBeenCalledWith({ type: "setScreenShareEnabled", enabled: false }, expect.anything());
    } finally {
      await act(async () => root.unmount());
      container.remove();
      client.dispose();
    }
  });
});
