import React, { useState, useRef, useEffect } from "react";
interface MediaDevice {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
  groupId?: string;
}
import { Microphone01Icon, MicrophoneOff01Icon, Video01Icon, VideoOffIcon, ArrowDown01Icon, Tick01Icon, VolumeHighIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { ControlButton } from "../atomic";
import { Tooltip } from "../atomic/Tooltip";
import type { ChalkHapticInput } from "../../internal/useHaptics";
import { useHaptics } from "../../internal/useHaptics";

export interface DeviceControlButtonProps {
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
  haptic?: ChalkHapticInput | false;
  size?: "sm" | "md" | "lg";
  appearance?: "default" | "dock";
}

export const DeviceControlButton = ({
  type,
  isActive,
  onToggle,
  devices,
  selectedDeviceId,
  onDeviceChange,
  secondaryDevices,
  selectedSecondaryDeviceId,
  onSecondaryDeviceChange,
  orientation = "up",
  className,
  disabled = false,
  haptic = "soft",
  size = "md",
  appearance = "default",
}: DeviceControlButtonProps) => {
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

  const icon = isMic ? isActive ? <Microphone01Icon /> : <MicrophoneOff01Icon className="text-[#dc2626]" /> : isActive ? <Video01Icon /> : <VideoOffIcon className="text-[#dc2626]" />;

  const label = isMic ? (isActive ? "Mute microphone" : "Unmute microphone") : isActive ? "Turn off camera" : "Turn on camera";
  const dropdownLabel = isMic ? "Microphone" : "Camera";
  const dock = appearance === "dock";

  return (
    <div className={cn("relative z-10 flex items-center pointer-events-auto", isOpen && "z-[60]", className)} ref={containerRef}>
      {/* Main Toggle Button */}
      <ControlButton
        icon={icon}
        label={label}
        onClick={onToggle}
        active={isActive}
        disabled={disabled}
        haptic={haptic}
        size={size}
        className={cn(dock ? "h-[52px] w-[52px] !rounded-full !bg-[#202329] !text-white shadow-[0_5px_16px_rgba(12,14,18,0.18)] hover:-translate-y-0.5 hover:!bg-[#343840]" : "rounded-r-none border-r border-black/5 bg-black/5 dark:border-white/5 dark:bg-white/10", isOpen && "brightness-110")}
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
            dock ? "absolute -right-1.5 -bottom-1.5 h-7 w-7 rounded-full border-2 border-[#fbfaf7] bg-[#343840] p-0 !text-white shadow-sm hover:bg-[#4a4f59]" : "rounded-r-full border-l border-black/5 bg-black/5 shadow-lg hover:brightness-110 dark:border-white/5 dark:bg-white/10",
            !dock && "text-foreground",
            !dock && chevronSizeClass,
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
            "pointer-events-auto absolute z-[70] max-h-[360px] min-w-[260px] max-w-[300px] overflow-y-auto rounded-[10px] border border-[#c9c8c2] bg-white py-2 text-[#0c0e12] shadow-[0_18px_44px_rgba(12,14,18,0.16)] animate-in fade-in zoom-in-95 duration-150",
            orientation === "up" ? "bottom-full mb-3" : "top-full mt-3",
            "left-0",
          )}
        >
          <div className="mb-1 border-b border-[#e5e4df] px-4 pb-3 pt-1 text-sm font-semibold">{dropdownLabel}</div>

          <div className="max-h-[220px] overflow-y-auto py-1">
            {devices.length === 0 ? (
              <div className="px-4 py-3 text-sm text-[#858a92]">No devices found</div>
            ) : (
              devices.map((device) => {
                const isSelected = selectedDeviceId === device.deviceId;
                return (
                  <button
                    key={device.deviceId}
                    type="button"
                    onClick={() => handleSelectDevice(device.deviceId)}
                    className={cn("flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-[#f7f6f2]", isSelected ? "bg-[#edf7fa] font-semibold text-[#315f72]" : "text-[#555b65]")}
                  >
                    <div className="flex items-center gap-3 truncate pr-2">
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", isSelected ? "bg-[#55aac9]" : "bg-[#c9c8c2]")} />
                      <span className="truncate">{device.label || `${dropdownLabel} ${device.deviceId.slice(0, 4)}`}</span>
                    </div>
                    {isSelected && <Tick01Icon size={14} className="shrink-0" />}
                  </button>
                );
              })
            )}
          </div>

          {secondaryDevices && secondaryDevices.length > 0 && (
            <>
              <div className="my-1 border-y border-[#e5e4df] bg-[#fbfaf7] px-4 py-2.5 text-sm font-semibold">Speakers</div>
              <div className="max-h-[180px] overflow-y-auto py-1">
                {secondaryDevices.map((device) => {
                  const isSelected = selectedSecondaryDeviceId === device.deviceId;
                  return (
                    <button
                      key={device.deviceId}
                      type="button"
                      onClick={() => handleSelectSecondaryDevice(device.deviceId)}
                      className={cn("flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-[#f7f6f2]", isSelected ? "bg-[#edf7fa] font-semibold text-[#315f72]" : "text-[#555b65]")}
                    >
                      <div className="flex items-center gap-3 truncate pr-2">
                        <VolumeHighIcon size={14} className={cn("shrink-0", isSelected ? "text-[#315f72]" : "text-[#858a92]")} />
                        <span className="truncate">{device.label || `Speaker ${device.deviceId.slice(0, 4)}`}</span>
                      </div>
                      {isSelected && <Tick01Icon size={14} className="shrink-0" />}
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
