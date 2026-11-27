import React from "react";
import { ChalkIconButton } from "../chalk-ui";
import { VolumeHighIcon } from "../../utils/icons";
import { LeaveMenu } from "./LeaveMenu";
import type { MediaDevice } from "./control-bar-behavior";
import type { ControlBarSurfaceProps as SurfaceBehaviorProps } from "./control-bar-props";
import { MediaGlyph, ShellIcon } from "./ShellIcon";

/** The selected device's name, or the first one when none is chosen yet, for a row of the More sheet. */
export function DeviceValue({ devices, selectedDeviceId }: { readonly devices: readonly MediaDevice[]; readonly selectedDeviceId?: string }) {
  const device = devices.find((candidate) => candidate.deviceId === selectedDeviceId) ?? devices[0];
  return device?.label ? <span className="chalk-sheet-value">{device.label}</span> : null;
}

/** The device rows of the phone dock's sheet; each opens its device sheet. */
export function DockDeviceRows({
  showMicrophone,
  showCamera,
  onOpenMicrophone,
  onOpenCamera,
  audioInputDevices,
  selectedAudioInput,
  videoInputDevices,
  selectedVideoInput,
}: {
  readonly showMicrophone: boolean;
  readonly showCamera: boolean;
  readonly onOpenMicrophone: () => void;
  readonly onOpenCamera: () => void;
  readonly audioInputDevices: readonly MediaDevice[];
  readonly selectedAudioInput?: string;
  readonly videoInputDevices: readonly MediaDevice[];
  readonly selectedVideoInput?: string;
}): React.JSX.Element {
  return (
    <>
      {showMicrophone ? (
        <button type="button" className="chalk-sheet-row" aria-haspopup="dialog" onClick={onOpenMicrophone}>
          <VolumeHighIcon />
          <span className="chalk-sheet-label-text">Microphone and speaker</span>
          <DeviceValue devices={audioInputDevices} selectedDeviceId={selectedAudioInput} />
        </button>
      ) : null}
      {showCamera ? (
        <button type="button" className="chalk-sheet-row" aria-haspopup="dialog" onClick={onOpenCamera}>
          <MediaGlyph kind="cam" slashed={false} busy={false} />
          <span className="chalk-sheet-label-text">Camera</span>
          <DeviceValue devices={videoInputDevices} selectedDeviceId={selectedVideoInput} />
        </button>
      ) : null}
    </>
  );
}

/** The Leave control, shown only when the call can be left from the dock. */
export function DockLeave({ show, onLeft, onEndForEveryone }: { readonly show: boolean; readonly onLeft: SurfaceBehaviorProps["onLeft"]; readonly onEndForEveryone: SurfaceBehaviorProps["onEndForEveryone"] }): React.JSX.Element | null {
  if (!show) return null;
  return (
    <LeaveMenu
      onLeave={onLeft}
      onEndForEveryone={onEndForEveryone}
      renderButton={(buttonProps) => (
        <ChalkIconButton {...buttonProps} size="lg" tone="danger" className="chalk-shell-leave" aria-label="Leave call">
          <ShellIcon name="hang" />
        </ChalkIconButton>
      )}
    />
  );
}
