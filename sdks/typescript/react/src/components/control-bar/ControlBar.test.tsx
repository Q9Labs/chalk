// @vitest-environment happy-dom
import { act } from "react";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { ControlBar } from "./ControlBar";

describe("compact screen sharing", () => {
  it("starts and stops screen sharing", async () => {
    const onCommand = vi.fn();
    const client = createPreviewClient(undefined, { onCommand });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <>
            <ChalkProvider client={client}>
              <ControlBar density="compact" buttons={["screenshare"]} />
            </ChalkProvider>
          </>,
        ),
      );
      expect(container.querySelector('[data-tour="controls-screenshare"]')).toBeNull();
      await act(async () => client.setSnapshot(createSnapshot(["publishScreen"])));
      const start = container.querySelector('button[aria-label="Share screen"]');
      if (!(start instanceof HTMLButtonElement)) throw new Error("Compact screen-share control is missing");
      await act(async () => start.click());
      expect(onCommand).toHaveBeenCalledWith({ type: "setScreenShareEnabled", enabled: true }, expect.anything());
      const stop = container.querySelector('button[aria-label="Stop sharing"]');
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

describe("media command failures", () => {
  it("preserves public codes and reports the originating media source", async () => {
    const preview = createPreviewClient(createSnapshot(["publishAudio", "publishVideo", "publishScreen"]));
    const onCommandError = vi.fn();
    const client = {
      ...preview,
      media: {
        ...preview.media,
        setMicrophoneEnabled: async () => {
          throw new SpaceClientError({ code: "media.permission_denied", recoverable: true, message: "Blocked microphone" });
        },
        setCameraEnabled: async () => {
          throw new SpaceClientError({ code: "media.device_not_found", recoverable: true, message: "Missing camera" });
        },
        setScreenShareEnabled: async () => {
          throw new Error("Capture failed");
        },
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ChalkProvider client={client}>
            <ControlBar buttons={["mic", "video", "screenshare"]} onCommandError={onCommandError} />
          </ChalkProvider>,
        ),
      );
      for (const [part, code, source] of [
        ["mic", "media.permission_denied", "microphone"],
        ["video", "media.device_not_found", "camera"],
        ["share", "client.internal_error", "screen"],
      ]) {
        const button = container.querySelector(`[data-part="${part}-split"] .chalk-shell-main`);
        if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing ${part} control`);
        await act(async () => button.click());
        expect(onCommandError).toHaveBeenLastCalledWith(expect.objectContaining({ code }), source);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      preview.dispose();
    }
  });
});
