// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Entrance } from "./Entrance";
import { COSMIC_CHALK_THEME } from "../../theme";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Entrance", () => {
  it("offers an optional Back or Cancel action for standalone arrival flows", () => {
    const onCancel = vi.fn();
    const onJoin = vi.fn();
    const view = render(<Entrance spaceName="Design review" defaultDisplayName="Ada" onJoin={onJoin} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onCancel).toHaveBeenCalledOnce();

    view.rerender(<Entrance spaceName="Design review" defaultDisplayName="Ada" joining onJoin={onJoin} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);

    view.rerender(<Entrance spaceName="Design review" defaultDisplayName="Ada" onJoin={onJoin} />);
    expect(screen.queryByRole("button", { name: /Back|Cancel/u })).not.toBeInTheDocument();
  });

  it("applies a supplied palette, texture, and inline token set to the arrival root", () => {
    render(<Entrance spaceName="Design review" defaultDisplayName="Ada" theme={COSMIC_CHALK_THEME} onJoin={() => undefined} />);

    const root = screen.getByRole("main");
    expect(root).toHaveAttribute("data-chalk-theme", "dark");
    expect(root).toHaveAttribute("data-chalk-palette", "cosmic-chalk");
    expect(root).toHaveAttribute("data-chalk-texture", "slate");
    expect(root).toHaveStyle({ "--chalk-canvas": "#080f20", "--chalk-accent": "#8fdcff" });
  });

  it("uses selected capture devices for the local preview and forwards output selection", async () => {
    const stream = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn(async () => stream);
    const onAudioOutputChange = vi.fn();
    const onJoin = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => []) } });

    const originalSrcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, get: () => null, set: () => undefined });
    try {
      const view = render(
        <Entrance
          spaceName="Design review"
          defaultDisplayName="Ada"
          defaults={{ microphone: true, camera: true }}
          audioInputDevices={[{ deviceId: "mic-1", label: "Desk microphone" }]}
          videoInputDevices={[{ deviceId: "camera-1", label: "Wide camera" }]}
          audioOutputDevices={[{ deviceId: "speaker-1", label: "Headphones" }]}
          onAudioOutputChange={onAudioOutputChange}
          onJoin={onJoin}
        />,
      );

      await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true }));
      fireEvent.click(screen.getByRole("button", { name: "Choose microphone devices" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Microphone input" }), { target: { value: "mic-1" } });
      fireEvent.change(screen.getByRole("combobox", { name: "Audio output" }), { target: { value: "speaker-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Choose camera devices" }));
      fireEvent.change(screen.getByRole("combobox", { name: "Camera input" }), { target: { value: "camera-1" } });

      expect(onAudioOutputChange).toHaveBeenCalledWith("speaker-1");
      await waitFor(() => expect(getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: "mic-1" } }, video: { deviceId: { exact: "camera-1" } } }));
      fireEvent.click(screen.getByRole("button", { name: "Enter Space" }));
      expect(onJoin).toHaveBeenCalledWith({ displayName: "Ada", microphone: true, camera: true, audioInputDeviceId: "mic-1", videoInputDeviceId: "camera-1", audioOutputDeviceId: "speaker-1" });
      view.unmount();
    } finally {
      if (originalSrcObject) Object.defineProperty(HTMLMediaElement.prototype, "srcObject", originalSrcObject);
      else delete (HTMLMediaElement.prototype as { srcObject?: unknown }).srcObject;
    }
  });
});
