"use client";

import { useId, useState } from "react";
import type React from "react";

import { cn } from "../../utils/cn";
import { ArrowDown01Icon, Microphone01Icon, Video01Icon, VolumeHighIcon } from "../../utils/icons";
import { ChalkButton, ChalkIconButton, ChalkSelect } from "../chalk-ui";
import { useSkin } from "../skin-context";
import type { EntranceDevice, EntranceDeviceOptions } from "./types";

type DeviceControl = "microphone" | "camera";

type EntranceDeviceControlsProps = EntranceDeviceOptions & {
  readonly microphone: boolean;
  readonly camera: boolean;
  readonly onMicrophoneChange: (enabled: boolean) => void;
  readonly onCameraChange: (enabled: boolean) => void;
  readonly disabled?: boolean;
};

export function EntranceDeviceControls({
  microphone,
  camera,
  onMicrophoneChange,
  onCameraChange,
  audioInputDevices = [],
  videoInputDevices = [],
  audioOutputDevices = [],
  selectedAudioInput,
  selectedVideoInput,
  selectedAudioOutput,
  onAudioInputChange,
  onVideoInputChange,
  onAudioOutputChange,
  disabled = false,
}: EntranceDeviceControlsProps): React.JSX.Element {
  const [openControl, setOpenControl] = useState<DeviceControl | null>(null);
  const hasMicrophoneDevices = audioInputDevices.length > 0 || audioOutputDevices.length > 0;
  const hasCameraDevices = videoInputDevices.length > 0;

  const toggleSelector = (control: DeviceControl) => {
    setOpenControl((current) => (current === control ? null : control));
  };

  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
      <DeviceControlRow kind="microphone" label="Microphone" enabled={microphone} disabled={disabled} hasDevices={hasMicrophoneDevices} selectorOpen={openControl === "microphone"} onChange={onMicrophoneChange} onToggleSelector={() => toggleSelector("microphone")}>
        {audioInputDevices.length > 0 ? <DevicePicker kind="microphone" devices={audioInputDevices} selectedDeviceId={selectedAudioInput} onChange={onAudioInputChange} label="Microphone input" disabled={disabled} /> : null}
        {audioOutputDevices.length > 0 ? <DevicePicker kind="audio-output" devices={audioOutputDevices} selectedDeviceId={selectedAudioOutput} onChange={onAudioOutputChange} label="Audio output" disabled={disabled} /> : null}
      </DeviceControlRow>

      <DeviceControlRow kind="camera" label="Camera" enabled={camera} disabled={disabled} hasDevices={hasCameraDevices} selectorOpen={openControl === "camera"} onChange={onCameraChange} onToggleSelector={() => toggleSelector("camera")}>
        {videoInputDevices.length > 0 ? <DevicePicker kind="camera" devices={videoInputDevices} selectedDeviceId={selectedVideoInput} onChange={onVideoInputChange} label="Camera input" disabled={disabled} /> : null}
      </DeviceControlRow>
    </div>
  );
}

function DeviceControlRow({
  kind,
  label,
  enabled,
  disabled,
  hasDevices,
  selectorOpen,
  onChange,
  onToggleSelector,
  children,
}: {
  readonly kind: DeviceControl;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabled: boolean;
  readonly hasDevices: boolean;
  readonly selectorOpen: boolean;
  readonly onChange: (enabled: boolean) => void;
  readonly onToggleSelector: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const generatedId = useId();
  const skin = useSkin();
  const selectorId = `chalk-entrance-${kind}-devices-${generatedId}`;
  const toggleVariant = skin === "chalk" && enabled ? "solid" : "outline";
  const toggleTone = skin === "chalk" ? (enabled ? "success" : "danger") : "neutral";

  return (
    <div className="grid min-w-0 gap-2" data-chalk-entrance-device-control={kind}>
      <div className="flex min-w-0 gap-2">
        <ChalkButton type="button" aria-label={label} aria-pressed={enabled} disabled={disabled} onClick={() => onChange(!enabled)} variant={toggleVariant} tone={toggleTone} className="min-w-0 flex-1 justify-between px-4 py-3 text-left text-sm [&>span]:w-full [&>span]:justify-between">
          <span className="flex min-w-0 items-center gap-2">
            <EntranceDeviceIcon kind={kind} />
            <span>{label}</span>
          </span>
          <span className={enabled ? "text-[var(--chalk-positive)]" : "text-[var(--chalk-danger)]"}>{enabled ? "On" : "Off"}</span>
        </ChalkButton>

        {hasDevices ? (
          <ChalkIconButton type="button" aria-controls={selectorId} aria-expanded={selectorOpen} aria-label={`Choose ${label.toLowerCase()} devices`} disabled={disabled} onClick={onToggleSelector} seed={`entrance-${kind}-devices`} tone="neutral" className="min-h-11 w-11 shrink-0">
            <ArrowDown01Icon aria-hidden="true" size={16} className={cn("transition-transform", selectorOpen && "rotate-180")} />
          </ChalkIconButton>
        ) : null}
      </div>

      {selectorOpen ? (
        <div id={selectorId} role="group" aria-label={`${label} devices`} className="grid gap-3 rounded-md border border-[var(--chalk-app-line,var(--chalk-line))] bg-[var(--chalk-app-control,var(--chalk-canvas))] p-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function DevicePicker({
  kind,
  devices,
  selectedDeviceId,
  onChange,
  label,
  disabled,
}: {
  readonly kind: "microphone" | "camera" | "audio-output";
  readonly devices: readonly EntranceDevice[];
  readonly selectedDeviceId?: string | null;
  readonly onChange?: (deviceId: string) => void | Promise<void>;
  readonly label: string;
  readonly disabled: boolean;
}): React.JSX.Element {
  const generatedId = useId();
  const selectId = `chalk-entrance-${kind}-${generatedId}`;

  return (
    <div className="grid gap-1.5">
      <label htmlFor={selectId} className="flex items-center gap-2 text-xs font-medium text-[var(--chalk-muted-text)]">
        <EntranceDeviceIcon kind={kind} />
        <span>{label}</span>
      </label>
      <ChalkSelect id={selectId} aria-label={label} value={selectedDeviceId ?? ""} disabled={disabled} onChange={(event) => void onChange?.(event.currentTarget.value)} className="min-h-9 text-xs">
        <option value="" disabled>
          Select device
        </option>
        {devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || "Unnamed device"}
          </option>
        ))}
      </ChalkSelect>
    </div>
  );
}

export function EntranceDeviceIcon({ kind }: { readonly kind: "microphone" | "camera" | "audio-output" }): React.JSX.Element {
  if (kind === "microphone") return <Microphone01Icon aria-hidden="true" size={18} />;
  if (kind === "camera") return <Video01Icon aria-hidden="true" size={18} />;
  return <VolumeHighIcon aria-hidden="true" size={18} />;
}
