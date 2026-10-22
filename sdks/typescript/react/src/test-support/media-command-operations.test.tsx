// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SpaceClientError } from "@q9labsai/chalk-client";
import { createConvergenceScenario } from "../../../client/tests/helpers/media-convergence";
import { createBrowserMediaDevices } from "../../../client/src/connection/media-devices";
import { commandFailureMessage } from "../components/control-bar/command-failure";
import { ChalkProvider } from "../bindings/context";
import { createPreviewClient, createSnapshot } from "./preview-client";
import { SpaceView } from "../components/space-view/SpaceView";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

it("distinguishes real invalid device selection from an expired request", async () => {
  const { client } = createConvergenceScenario("camera");
  try {
    await client.join({ camera: false, microphone: false });
    for (const source of ["camera", "microphone", "speaker"] as const) {
      const method = source === "camera" ? "selectCamera" : source === "microphone" ? "selectMicrophone" : "selectSpeaker";
      let observed;
      try {
        await client.media[method]("");
      } catch (cause) {
        observed = cause;
      }
      expect(observed).toBeInstanceOf(SpaceClientError);
      if (!(observed instanceof SpaceClientError)) throw Error("Missing typed failure");
      expect(observed.message).toBe("A media device ID is required");
      expect(commandFailureMessage(observed, source, "select")).toBe(`Choose a valid ${source} from the device list.`);
    }
  } finally {
    client.dispose();
  }
});

it.each(["camera", "microphone", "screen"] as const)("preserves supported-browser guidance for real %s capture", async (source) => {
  const { client, setEnabled } = createConvergenceScenario(source, { mediaDevices: createBrowserMediaDevices() });
  try {
    await client.join({ camera: false, microphone: false });
    let observed;
    try {
      await setEnabled(true);
    } catch (cause) {
      observed = cause;
    }
    expect(observed).toBeInstanceOf(SpaceClientError);
    if (!(observed instanceof SpaceClientError)) throw Error("Missing typed failure");
    expect(observed.code).toBe("environment.unsupported");
    expect(observed.message).toMatch(/supported browser|HTTPS/);
    const displayed = commandFailureMessage(observed, source, "start");
    expect(displayed).toMatch(/supported browser over HTTPS/);
  } finally {
    client.dispose();
  }
});

it("does not offer a no-op retry for speaker selection", async () => {
  const snapshot = createSnapshot(["publishAudio"]);
  const preview = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
  const selectSpeaker = vi.fn(async (_deviceId: string) => {
    throw new SpaceClientError({ code: "media.device_busy", recoverable: true, message: "Output unavailable" });
  });
  const client = { ...preview, media: { ...preview.media, selectSpeaker } };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={client}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select microphone"]')?.click());
    const speaker = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')).find((item) => item.textContent === "Preview speaker · headphones");
    expect(speaker).toBeDefined();
    await act(async () => speaker instanceof HTMLElement && speaker.click());
    expect(selectSpeaker).toHaveBeenCalledOnce();
    const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Try again");
    expect(retry).toBeUndefined();
    expect(selectSpeaker).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Your speaker is being used by another app");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    preview.dispose();
  }
});

it("describes actual speaker playback failures as a speaker test", async () => {
  const snapshot = createSnapshot(["publishAudio"]);
  const preview = createPreviewClient({ ...snapshot, connection: { ...snapshot.connection, status: "live" } });
  const audioContext = vi.fn(function () {
    throw new DOMException("Audio playback blocked by browser", "NotAllowedError");
  });
  vi.stubGlobal("AudioContext", audioContext);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChalkProvider client={preview}>
          <SpaceView features={{ sounds: false }} generatedAvatars={false} />
        </ChalkProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select microphone"]')?.click());
    const test = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent?.includes("Test speaker"));
    expect(test).toBeDefined();
    await act(async () => test instanceof HTMLElement && test.click());
    expect(audioContext).toHaveBeenCalled();
    expect(container.textContent).toContain("Couldn’t play the speaker test.");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    preview.dispose();
  }
});
