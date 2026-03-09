import { describe, it, expect, vi } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { SettingsPanel } from "../../components/composite/SettingsPanel";

describe("SettingsPanel", () => {
  const devices: MediaDeviceInfo[] = [{ deviceId: "1", kind: "audioinput", label: "Mic 1", groupId: "g1", toJSON: () => ({}) }];

  it("renders correctly and allows tab switching", () => {
    const { getByText, getByLabelText } = render(<SettingsPanel audioInputDevices={devices} audioOutputDevices={[]} videoInputDevices={[]} />);
    expect(getByText("Microphone")).toBeDefined();

    fireEvent.click(getByText("Video"));
    expect(getByText("Camera")).toBeDefined();
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(<SettingsPanel audioInputDevices={[]} audioOutputDevices={[]} videoInputDevices={[]} onClose={onClose} />);
    fireEvent.click(getByLabelText("Close settings"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
