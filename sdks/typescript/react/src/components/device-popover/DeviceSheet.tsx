import { lazy, Suspense, useState, type ReactNode } from "react";
import { ChalkSheet } from "../chalk-ui";
import { VolumeHighIcon } from "../../utils/icons";
import type { CameraPreview as CameraPreviewHandle } from "@q9labsai/chalk-client";
import type { MediaDevice } from "../control-bar/control-bar-behavior";
import { CameraPreview, InputLevel } from "./DevicePreview";

const CameraBackgroundPicker = lazy(() => import("./CameraBackgroundPicker").then((module) => ({ default: module.CameraBackgroundPicker })));

interface DeviceSheetProps {
  readonly type: "mic" | "video";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly devices: readonly MediaDevice[];
  readonly selectedDeviceId?: string;
  readonly onDeviceChange: (deviceId: string) => void;
  readonly secondaryDevices?: readonly MediaDevice[];
  readonly selectedSecondaryDeviceId?: string;
  readonly onSecondaryDeviceChange?: (deviceId: string) => void;
  readonly track?: MediaStreamTrack | null;
  readonly captureCameraPreview?: () => Promise<CameraPreviewHandle>;
  readonly noiseSuppression?: boolean;
  readonly onNoiseSuppressionChange?: (enabled: boolean) => void;
  readonly mirrored?: boolean;
  readonly onMirrorChange?: (mirrored: boolean) => void;
  readonly onTestSpeaker?: () => void;
}

function Check({ on }: { readonly on: boolean }) {
  return (
    <span className="chalk-sheet-lead" aria-hidden="true">
      {on ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : null}
    </span>
  );
}

function DeviceRow({ checked, disabled, onClick, children }: { readonly checked: boolean; readonly disabled?: boolean; readonly onClick?: () => void; readonly children: ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="chalk-sheet-row" disabled={disabled} onClick={onClick}>
      <Check on={checked} />
      {children}
    </button>
  );
}

function SwitchRow({ label, hint, checked, onChange }: { readonly label: string; readonly hint?: string; readonly checked: boolean; readonly onChange?: (enabled: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="chalk-sheet-row" disabled={!onChange} onClick={() => onChange?.(!checked)}>
      <span className="chalk-shell-device-label">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      <span className="chalk-switch" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

const sheetBackground = {
  Label: ({ children }: { readonly children: ReactNode }) => <div className="chalk-sheet-label">{children}</div>,
  Item: ({ checked, disabled, onClick, children }: { readonly checked: boolean; readonly disabled: boolean; readonly closeOnClick: boolean; readonly onClick: () => void; readonly children: ReactNode }) => (
    <DeviceRow checked={checked} disabled={disabled} onClick={onClick}>
      {children}
    </DeviceRow>
  ),
};

/**
 * The microphone or camera picker as a phone bottom sheet. The rows are the ones in the desktop
 * popover; choosing one switches the device and leaves the sheet open, so the meter or the preview shows it worked.
 */
export default function DeviceSheet({
  type,
  open,
  onOpenChange,
  devices,
  selectedDeviceId,
  onDeviceChange,
  secondaryDevices,
  selectedSecondaryDeviceId,
  onSecondaryDeviceChange,
  track,
  captureCameraPreview,
  noiseSuppression = true,
  onNoiseSuppressionChange,
  mirrored = true,
  onMirrorChange,
  onTestSpeaker,
}: DeviceSheetProps) {
  const [previewDeviceId, setPreviewDeviceId] = useState<string | null>(null);
  const mic = type === "mic";
  const label = mic ? "Microphone" : "Camera";
  return (
    <ChalkSheet variant="details" open={open} onOpenChange={onOpenChange} title={mic ? "Audio" : "Camera"}>
      {mic ? null : <CameraPreview onDeviceId={setPreviewDeviceId} track={track} mirrored={mirrored} open={open} selectedDeviceId={selectedDeviceId} captureCameraPreview={captureCameraPreview} />}
      <div className="chalk-sheet-label">{label}</div>
      <div className="chalk-sheet-group" role="radiogroup" aria-label={label}>
        {devices.length ? (
          devices.map((device) => (
            <DeviceRow key={device.deviceId} checked={selectedDeviceId === device.deviceId} onClick={() => onDeviceChange(device.deviceId)}>
              <span className="chalk-shell-device-label">{device.label || label}</span>
              {mic && selectedDeviceId === device.deviceId ? <InputLevel track={track} /> : null}
            </DeviceRow>
          ))
        ) : (
          <div className="chalk-sheet-row">No devices found</div>
        )}
      </div>
      {mic ? (
        <>
          <div className="chalk-sheet-group">
            <SwitchRow label="Noise suppression" hint="Filters keyboard and background noise" checked={noiseSuppression} onChange={onNoiseSuppressionChange} />
          </div>
          {secondaryDevices?.length ? (
            <>
              <div className="chalk-sheet-label">Speaker</div>
              <div className="chalk-sheet-group" role="radiogroup" aria-label="Speaker">
                {secondaryDevices.map((device) => (
                  <DeviceRow key={device.deviceId} checked={selectedSecondaryDeviceId === device.deviceId} onClick={() => onSecondaryDeviceChange?.(device.deviceId)}>
                    <span className="chalk-shell-device-label">{device.label || "Speaker"}</span>
                  </DeviceRow>
                ))}
                {onTestSpeaker ? (
                  <button type="button" className="chalk-sheet-row" onClick={onTestSpeaker}>
                    <VolumeHighIcon />
                    <span>Test speaker</span>
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          {previewDeviceId && open ? (
            <Suspense fallback={null}>
              <div className="chalk-sheet-group">
                <CameraBackgroundPicker key={previewDeviceId} deviceId={previewDeviceId} menu={sheetBackground} />
              </div>
            </Suspense>
          ) : null}
          <div className="chalk-sheet-group">
            <SwitchRow label="Mirror my video" checked={mirrored} onChange={onMirrorChange} />
          </div>
        </>
      )}
    </ChalkSheet>
  );
}
