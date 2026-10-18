import { Menu } from "@base-ui/react/menu";
import { useEffect, useRef, useState } from "react";
import { ChalkMenu, ChalkMenuItem, ChalkMenuLabel, ChalkTooltip } from "../chalk-ui";
import { Microphone01Icon, MicrophoneOff01Icon, Video01Icon, VideoOffIcon, ArrowDown01Icon, VolumeHighIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import type { HapticInput } from "../../internal/useHaptics";
import type { MediaDevice } from "../control-bar/control-bar-behavior";
import { ShellStyles } from "../control-bar/ShellStyles";

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
  busy?: boolean;
  haptic?: HapticInput | false;
  size?: "sm" | "md" | "lg";
  appearance?: "default" | "floating";
}

function InputLevel({ track }: { readonly track?: MediaStreamTrack | null }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track || track.readyState !== "live") return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
      setLevel(Math.min(100, Math.round(rms * 400)));
    }, 100);
    return () => {
      clearInterval(timer);
      source.disconnect();
      void context.close();
    };
  }, [track]);
  return (
    <span className="chalk-shell-level" role="meter" aria-label="Input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level}>
      <i style={{ transform: `scaleX(${level / 100})` }} />
    </span>
  );
}

function CameraPreview({ track, mirrored }: { readonly track?: MediaStreamTrack | null; readonly mirrored: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element || !track) return;
    element.srcObject = new MediaStream([track]);
    return () => {
      element.srcObject = null;
    };
  }, [track]);
  return (
    <div className="chalk-shell-preview">
      <video ref={video} autoPlay muted playsInline style={{ transform: mirrored ? "scaleX(-1)" : undefined }} />
      <small>{track ? "Only you see this preview" : "Camera is off"}</small>
    </div>
  );
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
  busy,
}: DevicePopoverProps) {
  const mic = type === "mic";
  const label = mic ? (isActive ? "Mute microphone" : "Unmute microphone") : isActive ? "Turn off camera" : "Turn on camera";
  return (
    <div data-part={`${type}-split`} className={cn("chalk-shell-split", className)} data-off={!isActive}>
      <ShellStyles />
      <ChalkTooltip
        trigger={
          <button type="button" className="chalk-shell-main" aria-label={busy ? `Updating ${mic ? "microphone" : "camera"}` : label} aria-pressed={isActive} disabled={disabled || busy} onClick={onToggle}>
            {mic ? isActive ? <Microphone01Icon /> : <MicrophoneOff01Icon /> : isActive ? <Video01Icon /> : <VideoOffIcon />}
          </button>
        }
      >
        {label}
      </ChalkTooltip>
      <ChalkMenu
        side={orientation === "up" ? "top" : "bottom"}
        className="chalk-device-menu"
        trigger={
          <button type="button" className="chalk-shell-caret" aria-label={`Select ${mic ? "microphone" : "camera"}`} disabled={disabled}>
            <ArrowDown01Icon />
          </button>
        }
      >
        {!mic ? <CameraPreview track={track} mirrored={mirrored} /> : null}
        <ChalkMenuLabel>{mic ? "Microphone" : "Camera"}</ChalkMenuLabel>
        {devices.length ? (
          devices.map((device) => (
            <ChalkMenuItem key={device.deviceId} checked={selectedDeviceId === device.deviceId} onClick={() => onDeviceChange(device.deviceId)}>
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
            <Menu.Separator className="my-1 border-t border-[var(--chalk-line)]" />
            <ChalkMenuLabel>Speaker</ChalkMenuLabel>
            {secondaryDevices?.map((device) => (
              <ChalkMenuItem key={device.deviceId} checked={selectedSecondaryDeviceId === device.deviceId} onClick={() => onSecondaryDeviceChange?.(device.deviceId)}>
                {device.label || "Speaker"}
              </ChalkMenuItem>
            ))}
            <ChalkMenuItem disabled={!onTestSpeaker} onClick={onTestSpeaker}>
              <VolumeHighIcon />
              Test speaker
            </ChalkMenuItem>
          </>
        ) : (
          <DeviceSwitch label="Mirror my video" checked={mirrored} onChange={onMirrorChange} />
        )}
      </ChalkMenu>
      {warning ? (
        <span className="chalk-shell-warning" role="img" aria-label={`${mic ? "Microphone" : "Camera"} blocked or unavailable`}>
          !
        </span>
      ) : null}
      {mic && speakingWhileMuted ? (
        <span className="chalk-shell-muted-hint" role="status">
          You’re muted
        </span>
      ) : null}
    </div>
  );
}
