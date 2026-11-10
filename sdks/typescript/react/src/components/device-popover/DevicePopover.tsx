import type { CameraPreview as CameraPreviewHandle } from "@q9labsai/chalk-client";
import { getCameraBackgroundFallback, subscribeCameraBackground } from "@q9labsai/chalk-client";
import { ChalkMenuPrimitive as Menu } from "../chalk-ui";
import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { ChalkMenu, ChalkMenuItem, ChalkMenuLabel, ChalkTooltip } from "../chalk-ui";
import { VolumeHighIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePhoneCall } from "../../internal/call-width";
import { useLongPress } from "../../internal/useLongPress";
import type { HapticInput } from "../../internal/useHaptics";
import type { MediaDevice } from "../control-bar/control-bar-behavior";
import { MediaGlyph, ShellIcon } from "../control-bar/ShellIcon";
import { ShellStyles } from "../control-bar/ShellStyles";
import { CameraPreview, InputLevel } from "./DevicePreview";

const DeviceSheet = lazy(() => import("./DeviceSheet"));
const CameraBackgroundPicker = lazy(() => import("./CameraBackgroundPicker").then((module) => ({ default: module.CameraBackgroundPicker })));
const backgroundMenu = { Label: ChalkMenuLabel, Item: ChalkMenuItem };

export interface DevicePopoverProps {
  type: "mic" | "video";
  isActive: boolean;
  onToggle: () => void;
  devices: readonly MediaDevice[];
  selectedDeviceId?: string;
  onDeviceChange: (deviceId: string) => void;
  secondaryDevices?: readonly MediaDevice[];
  selectedSecondaryDeviceId?: string;
  onSecondaryDeviceChange?: (deviceId: string) => void;
  track?: MediaStreamTrack | null;
  captureCameraPreview?: () => Promise<CameraPreviewHandle>;
  warning?: boolean;
  speakingWhileMuted?: boolean;
  noiseSuppression?: boolean;
  onNoiseSuppressionChange?: (enabled: boolean) => void;
  mirrored?: boolean;
  onMirrorChange?: (mirrored: boolean) => void;
  onTestSpeaker?: () => void;
  orientation?: "up" | "down";
  className?: string;
  disabled?: boolean;
  toggleDisabled?: boolean;
  busy?: boolean;
  onCancelPending?: () => void;
  haptic?: HapticInput | false;
  size?: "sm" | "md" | "lg";
  appearance?: "default" | "floating";
  /** The phone picker sheet. Press and hold on the button opens it; the dock's More sheet opens it too. */
  sheetOpen?: boolean;
  onSheetOpenChange?: (open: boolean) => void;
}

function DeviceSwitch({ label, checked, onChange }: { readonly label: string; readonly checked: boolean; readonly onChange?: (enabled: boolean) => void }) {
  return (
    <Menu.CheckboxItem className="chalk-menu-item" checked={checked} onCheckedChange={onChange} disabled={!onChange} closeOnClick={false}>
      <span>{label}</span>
      <span className="chalk-shell-menu-switch" aria-hidden="true">
        <span className="chalk-switch" aria-checked={checked}>
          <span />
        </span>
      </span>
    </Menu.CheckboxItem>
  );
}

export function DevicePopover({
  type,
  isActive,
  onToggle,
  devices,
  selectedDeviceId,
  onDeviceChange,
  secondaryDevices,
  selectedSecondaryDeviceId,
  onSecondaryDeviceChange,
  track,
  captureCameraPreview,
  warning,
  speakingWhileMuted,
  noiseSuppression = true,
  onNoiseSuppressionChange,
  mirrored = true,
  onMirrorChange,
  onTestSpeaker,
  orientation = "up",
  className,
  disabled,
  toggleDisabled,
  busy,
  onCancelPending,
  sheetOpen = false,
  onSheetOpenChange,
}: DevicePopoverProps) {
  const [open, setOpen] = useState(false);
  const [sheetLoaded, setSheetLoaded] = useState(false);
  if (sheetOpen && !sheetLoaded) setSheetLoaded(true);
  const phone = usePhoneCall();
  const hold = useLongPress(phone && onSheetOpenChange ? () => onSheetOpenChange(true) : undefined);
  const [previewDeviceId, setPreviewDeviceId] = useState<string | null>(null);
  const deviceId = previewDeviceId ?? selectedDeviceId ?? track?.getSettings().deviceId ?? "default";
  const backgroundFallback = useSyncExternalStore(
    subscribeCameraBackground,
    () => type === "video" && getCameraBackgroundFallback(deviceId) !== undefined,
    () => false,
  );
  const mic = type === "mic";
  const label = mic ? (isActive ? "Mute microphone" : "Unmute microphone") : isActive ? "Turn off camera" : "Turn on camera";
  return (
    <div data-part={`${type}-split`} className={cn("chalk-shell-split", className)} data-off={!isActive && !busy} data-camera-menu={!mic ? true : undefined}>
      <ShellStyles />
      <ChalkTooltip
        trigger={
          <button
            type="button"
            className="chalk-shell-main"
            aria-label={busy ? `${onCancelPending ? "Cancel connecting" : "Updating"} ${mic ? "microphone" : "camera"}` : label}
            aria-pressed={isActive}
            aria-busy={busy}
            disabled={disabled || (toggleDisabled && !(busy && onCancelPending)) || (busy && !onCancelPending)}
            onClick={busy && onCancelPending ? onCancelPending : onToggle}
            {...hold}
          >
            <MediaGlyph kind={mic ? "mic" : "cam"} slashed={!isActive && !busy} busy={Boolean(busy)} />
          </button>
        }
      >
        {warning ? `${mic ? "Microphone" : "Camera"} didn’t reach the call. Try turning it on again.` : busy ? `Connecting ${mic ? "microphone" : "camera"}…` : label}
      </ChalkTooltip>
      <ChalkMenu
        side={orientation === "up" ? "top" : "bottom"}
        className="chalk-device-menu"
        onOpenChange={setOpen}
        trigger={
          <button type="button" className="chalk-shell-caret" aria-label={`Select ${mic ? "microphone" : "camera"}`} disabled={disabled}>
            <ShellIcon name="down" />
          </button>
        }
      >
        {!mic ? <CameraPreview onDeviceId={setPreviewDeviceId} track={track} mirrored={mirrored} open={open} selectedDeviceId={selectedDeviceId} captureCameraPreview={captureCameraPreview} /> : null}
        <ChalkMenuLabel>{mic ? "Microphone" : "Camera"}</ChalkMenuLabel>
        {devices.length ? (
          devices.map((device) => (
            <ChalkMenuItem key={device.deviceId} checked={selectedDeviceId === device.deviceId} onClick={() => onDeviceChange(device.deviceId)} closeOnClick={false}>
              <span className="chalk-shell-device-label">
                {device.label || (mic ? "Microphone" : "Camera")}
                {mic && selectedDeviceId === device.deviceId ? <InputLevel track={track} /> : null}
              </span>
            </ChalkMenuItem>
          ))
        ) : (
          <ChalkMenuItem disabled>No devices found</ChalkMenuItem>
        )}
        {mic ? (
          <>
            <DeviceSwitch label="Noise suppression" checked={noiseSuppression} onChange={onNoiseSuppressionChange} />
            <Menu.Separator className="chalk-shell-menu-separator" />
            <ChalkMenuLabel>Speaker</ChalkMenuLabel>
            {secondaryDevices?.map((device) => (
              <ChalkMenuItem key={device.deviceId} checked={selectedSecondaryDeviceId === device.deviceId} onClick={() => onSecondaryDeviceChange?.(device.deviceId)} closeOnClick={false}>
                {device.label || "Speaker"}
              </ChalkMenuItem>
            ))}
            <ChalkMenuItem disabled={!onTestSpeaker} onClick={onTestSpeaker} closeOnClick={false}>
              <VolumeHighIcon />
              Test speaker
            </ChalkMenuItem>
          </>
        ) : (
          <>
            <Menu.Separator className="chalk-shell-menu-separator" />
            {open && previewDeviceId ? (
              <Suspense fallback={null}>
                <CameraBackgroundPicker key={previewDeviceId} deviceId={previewDeviceId} menu={backgroundMenu} />
              </Suspense>
            ) : null}
            <DeviceSwitch label="Mirror my video" checked={mirrored} onChange={onMirrorChange} />
          </>
        )}
      </ChalkMenu>
      {sheetLoaded && onSheetOpenChange ? (
        <Suspense fallback={null}>
          <DeviceSheet
            type={type}
            open={sheetOpen}
            onOpenChange={onSheetOpenChange}
            devices={devices}
            selectedDeviceId={selectedDeviceId}
            onDeviceChange={onDeviceChange}
            secondaryDevices={secondaryDevices}
            selectedSecondaryDeviceId={selectedSecondaryDeviceId}
            onSecondaryDeviceChange={onSecondaryDeviceChange}
            track={track}
            captureCameraPreview={captureCameraPreview}
            noiseSuppression={noiseSuppression}
            onNoiseSuppressionChange={onNoiseSuppressionChange}
            mirrored={mirrored}
            onMirrorChange={onMirrorChange}
            onTestSpeaker={onTestSpeaker}
          />
        </Suspense>
      ) : null}
      {warning ? (
        <span className="chalk-shell-warning" role="status" aria-label={`${mic ? "Microphone" : "Camera"} didn’t reach the call. Try turning it on again.`}>
          <span aria-hidden="true">!</span>
          <span className="sr-only">{mic ? "Microphone" : "Camera"} didn’t reach the call. Try turning it on again.</span>
        </span>
      ) : null}
      {busy ? (
        <span className="sr-only" role="status">
          Connecting {mic ? "microphone" : "camera"}…
        </span>
      ) : null}
      {mic && speakingWhileMuted ? (
        <span className="chalk-shell-muted-hint" role="status">
          You’re muted
        </span>
      ) : null}
      {backgroundFallback ? (
        <span className="chalk-shell-muted-hint chalk-shell-background-hint" role="status">
          Background off to keep video smooth.
        </span>
      ) : null}
    </div>
  );
}
