import { describe, expect, it, vi } from "bun:test";
import { fireEvent, render } from "@testing-library/react";

import { DeviceControlButton } from "../../components/composite/DeviceControlButton";

describe("DeviceControlButton", () => {
  it("switches the selected primary device from the dropdown", () => {
    const onDeviceChange = vi.fn();
    const { container, getByText } = render(
      <DeviceControlButton
        type="mic"
        isActive={true}
        onToggle={() => {}}
        devices={[
          { deviceId: "mic-1", kind: "audioinput", label: "Microphone 1" },
          { deviceId: "mic-2", kind: "audioinput", label: "Microphone 2" },
        ]}
        selectedDeviceId="mic-1"
        onDeviceChange={onDeviceChange}
      />,
    );

    const toggleButton = container.querySelector('button[aria-haspopup="true"]') as HTMLButtonElement | null;

    expect(toggleButton).not.toBeNull();
    fireEvent.click(toggleButton as HTMLButtonElement);
    fireEvent.click(getByText("Microphone 2"));

    expect(onDeviceChange).toHaveBeenCalledWith("mic-2");
  });

  it("switches the selected secondary device from the dropdown", () => {
    const onSecondaryDeviceChange = vi.fn();
    const { container, getByText } = render(
      <DeviceControlButton
        type="mic"
        isActive={true}
        onToggle={() => {}}
        devices={[{ deviceId: "mic-1", kind: "audioinput", label: "Microphone 1" }]}
        selectedDeviceId="mic-1"
        onDeviceChange={() => {}}
        secondaryDevices={[
          { deviceId: "spk-1", kind: "audiooutput", label: "Speaker 1" },
          { deviceId: "spk-2", kind: "audiooutput", label: "Speaker 2" },
        ]}
        selectedSecondaryDeviceId="spk-1"
        onSecondaryDeviceChange={onSecondaryDeviceChange}
      />,
    );

    const toggleButton = container.querySelector('button[aria-haspopup="true"]') as HTMLButtonElement | null;

    expect(toggleButton).not.toBeNull();
    fireEvent.click(toggleButton as HTMLButtonElement);
    fireEvent.click(getByText("Speaker 2"));

    expect(onSecondaryDeviceChange).toHaveBeenCalledWith("spk-2");
  });
});
