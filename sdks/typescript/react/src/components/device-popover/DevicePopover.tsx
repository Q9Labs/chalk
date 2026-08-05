import React, { useState, useRef, useEffect } from "react";
interface MediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
}
import { Microphone01Icon, MicrophoneOff01Icon, Video01Icon, VideoOffIcon, ArrowDown01Icon, Tick01Icon, VolumeHighIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { ControlBarButton } from "../atomic";
import { Tooltip } from "../atomic/Tooltip";
import type { HapticInput } from "../../internal/useHaptics";
import { useHaptics } from "../../internal/useHaptics";

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
  haptic?: HapticInput | false;
  size?: "sm" | "md" | "lg";
  appearance?: "default" | "floating";
}

export const DevicePopover = ({ type, isActive, onToggle, devices, selectedDeviceId, onDeviceChange, secondaryDevices, selectedSecondaryDeviceId, onSecondaryDeviceChange, orientation = "up", className, disabled = false, haptic = "soft", size = "md", appearance = "default" }: DevicePopoverProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { trigger } = useHaptics({
    enabled: !disabled && haptic !== false,
  });

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("click", handleClickOutside);
      return () => document.removeEventListener("click", handleClickOutside);
    }
  }, [isOpen]);

  const toggleDropdown = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!disabled) {
      if (haptic !== false) {
        void trigger(haptic);
      }
      setIsOpen(!isOpen);
    }
  };

  const handleSelectDevice = (deviceId: string) => {
    if (haptic !== false) {
      void trigger(haptic);
    }
    onDeviceChange(deviceId);
    setIsOpen(false);
  };

  const handleSelectSecondaryDevice = (deviceId: string) => {
    if (haptic !== false) {
      void trigger(haptic);
    }
    onSecondaryDeviceChange?.(deviceId);
    setIsOpen(false);
  };

  const isMic = type === "mic";
  const chevronSizeClass = size === "sm" ? "h-9 px-1.5" : size === "lg" ? "h-14 px-2.5" : "h-11 px-1.5";

  const icon = isMic ? isActive ? <Microphone01Icon /> : <MicrophoneOff01Icon className="text-[var(--chalk-app-danger)]" /> : isActive ? <Video01Icon /> : <VideoOffIcon className="text-[var(--chalk-app-danger)]" />;

  const label = isMic ? (isActive ? "Mute microphone" : "Unmute microphone") : isActive ? "Turn off camera" : "Turn on camera";
  const dropdownLabel = isMic ? "Microphone" : "Camera";
  const floating = appearance === "floating";

  return (
    <div className={cn("relative z-10 flex items-center pointer-events-auto", isOpen && "z-[60]", className)} ref={containerRef}>
      {/* Main Toggle Button */}
      <ControlBarButton
        icon={icon}
        label={label}
        onClick={onToggle}
        active={isActive}
        disabled={disabled}
        haptic={haptic}
        size={size}
        className={cn(
          floating
            ? "chalk-textured-surface h-[52px] w-[52px] !rounded-full !bg-[var(--chalk-app-control-primary)] !text-white shadow-[var(--chalk-app-shadow-control)] hover:-translate-y-0.5 hover:!bg-[var(--chalk-app-control-primary-hover)]"
            : "rounded-r-none border-r border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)]",
          isOpen && "brightness-110",
        )}
      />

      {/* Chevron Trigger */}
      <Tooltip content={`Select ${dropdownLabel}`} position={orientation === "up" ? "top" : "bottom"}>
        <button
          type="button"
          onClick={toggleDropdown}
          disabled={disabled || (devices.length === 0 && (!secondaryDevices || secondaryDevices.length === 0))}
          title={`Select ${dropdownLabel.toLowerCase()}`}
          aria-label={`Select ${dropdownLabel.toLowerCase()}`}
          className={cn(
            "chalk-button-tactile flex items-center justify-center transition-all duration-300 ease-out",
            floating
              ? "chalk-textured-surface absolute -right-1.5 -bottom-1.5 h-7 w-7 rounded-full border-2 border-[var(--chalk-app-chrome)] bg-[var(--chalk-app-control-primary-hover)] p-0 !text-white shadow-sm hover:bg-[var(--chalk-app-line-strong)]"
              : "rounded-r-full border-l border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] shadow-[var(--chalk-app-shadow-control)] hover:bg-[var(--chalk-app-control-hover)]",
            !floating && "text-[var(--chalk-app-text)]",
            !floating && chevronSizeClass,
            isOpen && "brightness-110",
            disabled && "cursor-not-allowed opacity-50",
          )}
          aria-haspopup="true"
          aria-expanded={isOpen}
        >
          <ArrowDown01Icon size={14} className={cn("shrink-0 transition-transform duration-200", isOpen && "rotate-180")} />
        </button>
      </Tooltip>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          className={cn(
            "chalk-textured-surface pointer-events-auto absolute z-[70] max-h-[420px] w-[min(340px,calc(100vw-24px))] overflow-y-auto rounded-[14px] border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] p-2 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)] animate-in fade-in zoom-in-95 duration-150",
            orientation === "up" ? "bottom-full mb-3" : "top-full mt-3",
            "left-0",
          )}
        >
          <div className="flex items-center justify-between px-2 pb-2 pt-1.5">
            <span className="text-sm font-semibold">{dropdownLabel}</span>
            <span className="text-[11px] text-[var(--chalk-app-text-muted)]">Choose a device</span>
          </div>

          <div className="max-h-[240px] space-y-1 overflow-y-auto rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] p-1">
            {devices.length === 0 ? (
              <div className="px-4 py-3 text-sm text-[var(--chalk-app-text-muted)]">No devices found</div>
            ) : (
              devices.map((device) => {
                const isSelected = selectedDeviceId === device.deviceId;
                return (
                  <button
                    key={device.deviceId}
                    type="button"
                    onClick={() => handleSelectDevice(device.deviceId)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-[7px] px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--chalk-app-control-hover)]",
                      isSelected ? "bg-[var(--chalk-app-control-active)] font-semibold text-[var(--chalk-app-control-active-text)]" : "text-[var(--chalk-app-text)]",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-3 pr-2">
                      <span className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-full", isSelected ? "bg-[var(--chalk-app-control-active-line)] text-[var(--chalk-app-control-active-text)]" : "bg-[var(--chalk-app-control-group)] text-transparent")}>
                        <Tick01Icon size={12} />
                      </span>
                      <span className="truncate">{device.label || `${dropdownLabel} ${device.deviceId.slice(0, 4)}`}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {secondaryDevices && secondaryDevices.length > 0 && (
            <>
              <div className="flex items-center justify-between px-2 pb-2 pt-4">
                <span className="text-sm font-semibold">Speakers</span>
                <span className="text-[11px] text-[var(--chalk-app-text-muted)]">Audio output</span>
              </div>
              <div className="max-h-[180px] space-y-1 overflow-y-auto rounded-[10px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] p-1">
                {secondaryDevices.map((device) => {
                  const isSelected = selectedSecondaryDeviceId === device.deviceId;
                  return (
                    <button
                      key={device.deviceId}
                      type="button"
                      onClick={() => handleSelectSecondaryDevice(device.deviceId)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-[7px] px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--chalk-app-control-hover)]",
                        isSelected ? "bg-[var(--chalk-app-control-active)] font-semibold text-[var(--chalk-app-control-active-text)]" : "text-[var(--chalk-app-text)]",
                      )}
                    >
                      <div className="flex items-center gap-3 truncate pr-2">
                        <span className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-full", isSelected ? "bg-[var(--chalk-app-control-active-line)] text-[var(--chalk-app-control-active-text)]" : "bg-[var(--chalk-app-control-group)] text-[var(--chalk-app-text-muted)]")}>
                          {isSelected ? <Tick01Icon size={12} /> : <VolumeHighIcon size={12} />}
                        </span>
                        <span className="truncate">{device.label || `Speaker ${device.deviceId.slice(0, 4)}`}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
