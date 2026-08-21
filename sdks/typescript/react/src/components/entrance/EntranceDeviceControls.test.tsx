// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EntranceDeviceControls } from "./EntranceDeviceControls";

afterEach(cleanup);

const requiredProps = {
  microphone: true,
  camera: true,
  onMicrophoneChange: vi.fn(),
  onCameraChange: vi.fn(),
};

describe("EntranceDeviceControls", () => {
  it("keeps each device picker behind its matching media control", () => {
    render(
      <EntranceDeviceControls
        {...requiredProps}
        audioInputDevices={[{ deviceId: "mic-1", label: "Desk microphone" }]}
        videoInputDevices={[{ deviceId: "camera-1", label: "Wide camera" }]}
        audioOutputDevices={[{ deviceId: "speaker-1", label: "Headphones" }]}
        selectedAudioInput="mic-1"
        selectedVideoInput="camera-1"
        selectedAudioOutput="speaker-1"
      />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose microphone devices" }));
    expect(screen.getByRole("group", { name: "Microphone devices" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Microphone input" })).toHaveValue("mic-1");
    expect(screen.getByRole("combobox", { name: "Audio output" })).toHaveValue("speaker-1");
    expect(screen.queryByRole("combobox", { name: "Camera input" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose camera devices" }));
    expect(screen.queryByRole("group", { name: "Microphone devices" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Camera devices" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Camera input" })).toHaveValue("camera-1");
  });

  it("forwards media toggles and selections, then disables the controls together", () => {
    const onMicrophoneChange = vi.fn();
    const onCameraChange = vi.fn();
    const onAudioInputChange = vi.fn();
    const onVideoInputChange = vi.fn();
    const onAudioOutputChange = vi.fn();
    const controls = {
      microphone: true,
      camera: false,
      audioInputDevices: [
        { deviceId: "mic-1", label: "Desk microphone" },
        { deviceId: "mic-2", label: "USB microphone" },
      ],
      videoInputDevices: [
        { deviceId: "camera-1", label: "Wide camera" },
        { deviceId: "camera-2", label: "Studio camera" },
      ],
      audioOutputDevices: [
        { deviceId: "speaker-1", label: "Headphones" },
        { deviceId: "speaker-2", label: "Desk speakers" },
      ],
      onMicrophoneChange,
      onCameraChange,
      onAudioInputChange,
      onVideoInputChange,
      onAudioOutputChange,
    };

    const view = render(<EntranceDeviceControls {...controls} />);

    fireEvent.click(screen.getByRole("button", { name: "Microphone" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera" }));
    expect(onMicrophoneChange).toHaveBeenCalledWith(false);
    expect(onCameraChange).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Choose microphone devices" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Microphone input" }), { target: { value: "mic-2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Audio output" }), { target: { value: "speaker-2" } });
    expect(onAudioInputChange).toHaveBeenCalledWith("mic-2");
    expect(onAudioOutputChange).toHaveBeenCalledWith("speaker-2");

    fireEvent.click(screen.getByRole("button", { name: "Choose camera devices" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Camera input" }), { target: { value: "camera-2" } });
    expect(onVideoInputChange).toHaveBeenCalledWith("camera-2");

    view.rerender(<EntranceDeviceControls {...controls} disabled />);
    expect(screen.getByRole("button", { name: "Microphone" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Camera" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose microphone devices" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose camera devices" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Camera input" })).toBeDisabled();
  });

  it("keeps the media toggles available when no device list is known", () => {
    render(<EntranceDeviceControls {...requiredProps} />);

    expect(screen.getByRole("button", { name: "Microphone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Camera" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Choose/u })).not.toBeInTheDocument();
  });
});
