import React from "react";
interface MediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
}
import type { HapticInput } from "../../internal/useHaptics";
import { ClassicDevicePopover } from "./ClassicDevicePopover";

export interface DevicePopoverProps {
  type: "mic" | "video";
  isActive: boolean;
  onToggle: () => void;
  devices: readonly MediaDevice[];
  selectedDeviceId?: string;
  onDeviceChange: (deviceId: string) => void;

  // Optional secondary devices (e.g. speakers for mic)
  secondaryDevices?: readonly MediaDevice[];
  selectedSecondaryDeviceId?: string;
  onSecondaryDeviceChange?: (deviceId: string) => void;

  orientation?: "up" | "down";
  className?: string;
  disabled?: boolean;
  busy?: boolean;
  haptic?: HapticInput | false;
  size?: "sm" | "md" | "lg";
  appearance?: "default" | "floating";
}

export const DevicePopover = (props: DevicePopoverProps): React.JSX.Element => {
  return <ClassicDevicePopover {...props} />;
};
