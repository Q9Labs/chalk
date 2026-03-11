import React, { useState, useRef, useEffect } from "react";
import type { MediaDevice } from "@q9labs/chalk-core";
import { Microphone01Icon, MicrophoneOff01Icon, Video01Icon, VideoOffIcon, ArrowDown01Icon, Tick01Icon, VolumeHighIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { ControlButton } from "../atomic";
import { Tooltip } from "../atomic/Tooltip";
import type { ChalkHapticInput } from "../../hooks/ui/useHaptics";
import { useHaptics } from "../../hooks/ui/useHaptics";

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
}

export const DeviceControlButton = ({ type, isActive, onToggle, devices, selectedDeviceId, onDeviceChange, secondaryDevices, selectedSecondaryDeviceId, onSecondaryDeviceChange, orientation = "up", className, disabled = false, haptic = "soft", size = "md" }: DeviceControlButtonProps) => {
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

  const icon = isMic ? isActive ? <Microphone01Icon /> : <MicrophoneOff01Icon className="text-[#dc2626]" /> : isActive ? <Video01Icon /> : <VideoOffIcon className="text-[#dc2626]" />;

  const label = isMic ? (isActive ? "Mute" : "Unmute") : isActive ? "Stop Video" : "Start Video";
  const dropdownLabel = isMic ? "Microphone" : "Camera";

  return (
    <div className={cn("relative z-10 flex items-center pointer-events-auto", isOpen && "z-[60]", className)} ref={containerRef}>
      {/* Main Toggle Button */}
      <ControlButton icon={icon} label={label} onClick={onToggle} active={isActive} disabled={disabled} haptic={haptic} size={size} className={cn("rounded-r-none border-r border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/10", isOpen && "brightness-110")} />

      {/* Chevron Trigger */}
      <Tooltip content={`Select ${dropdownLabel}`} position={orientation === "up" ? "top" : "bottom"}>
        <button
          type="button"
          onClick={toggleDropdown}
          disabled={disabled || (devices.length === 0 && (!secondaryDevices || secondaryDevices.length === 0))}
          className={cn(
            "chalk-button-tactile h-11 px-1.5 flex items-center justify-center rounded-r-full transition-all duration-300 ease-out",
            "bg-black/5 dark:bg-white/10 shadow-lg hover:brightness-110 border-l border-black/5 dark:border-white/5",
            "text-foreground",
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
            "absolute z-[70] min-w-[240px] max-w-[280px] rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden py-1 animate-in fade-in zoom-in-95 duration-200 pointer-events-auto",
            orientation === "up" ? "bottom-full mb-3" : "top-full mt-3",
            "left-0",
          )}
        >
          <div className="px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-muted-foreground border-b border-border mb-1">{dropdownLabel}</div>

          <div className="max-h-[220px] overflow-y-auto py-1">
            {devices.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground italic">No devices found</div>
            ) : (
              devices.map((device) => {
                const isSelected = selectedDeviceId === device.deviceId;
                return (
                  <button
                    key={device.deviceId}
                    type="button"
                    onClick={() => handleSelectDevice(device.deviceId)}
                    className={cn("flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors", "hover:bg-muted", isSelected ? "bg-primary/10 text-primary font-medium" : "text-foreground/80")}
                  >
                    <div className="flex items-center gap-3 truncate pr-2">
                      <span className={cn("h-2 w-2 shrink-0 rounded-full", isSelected ? "bg-primary" : "bg-border")} />
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
              <div className="px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-muted-foreground border-y border-border my-1 bg-muted/50">Speakers</div>
              <div className="max-h-[180px] overflow-y-auto py-1">
                {secondaryDevices.map((device) => {
                  const isSelected = selectedSecondaryDeviceId === device.deviceId;
                  return (
                    <button
                      key={device.deviceId}
                      type="button"
                      onClick={() => handleSelectSecondaryDevice(device.deviceId)}
                      className={cn("flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors", "hover:bg-muted", isSelected ? "bg-primary/10 text-primary font-medium" : "text-foreground/80")}
                    >
                      <div className="flex items-center gap-3 truncate pr-2">
                        <VolumeHighIcon size={14} className={cn("shrink-0", isSelected ? "text-primary" : "opacity-50")} />
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
