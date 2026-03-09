import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { JoinSettings } from "./types";

export type PreJoinDropdown = "audio" | "video" | null;

export interface UsePreJoinUiStateParams {
  userName: string;
  error?: string;
  initialVideoEnabled: boolean;
  initialAudioEnabled: boolean;
  initialShowSettings: boolean;
  selectedVideoDevice?: string;
  selectedAudioInput?: string;
  selectedAudioOutput?: string;
  onJoin: (settings: JoinSettings) => void;
  dropdownRef: RefObject<HTMLDivElement | null>;
}

export interface UsePreJoinUiStateReturn {
  displayName: string;
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  showSettings: boolean;
  localError?: string;
  openDropdown: PreJoinDropdown;
  canJoin: boolean;
  setIsVideoEnabled: (value: boolean) => void;
  setIsAudioEnabled: (value: boolean) => void;
  setShowSettings: (value: boolean) => void;
  setLocalError: (value: string | undefined) => void;
  setOpenDropdown: (value: PreJoinDropdown) => void;
  setDisplayNameFromInput: (value: string) => void;
  toggleVideo: () => void;
  toggleAudio: () => void;
  toggleSettings: () => void;
  handleJoin: () => void;
}

export function usePreJoinUiState({ userName, error, initialVideoEnabled, initialAudioEnabled, initialShowSettings, selectedVideoDevice, selectedAudioInput, selectedAudioOutput, onJoin, dropdownRef }: UsePreJoinUiStateParams): UsePreJoinUiStateReturn {
  const [displayName, setDisplayName] = useState(userName);
  const [isVideoEnabled, setIsVideoEnabled] = useState(initialVideoEnabled);
  const [isAudioEnabled, setIsAudioEnabled] = useState(initialAudioEnabled);
  const [showSettings, setShowSettings] = useState(initialShowSettings);
  const [localError, setLocalError] = useState<string | undefined>(error);
  const [openDropdown, setOpenDropdown] = useState<PreJoinDropdown>(null);
  const displayNameTouchedRef = useRef(false);

  useEffect(() => {
    setLocalError(error);
  }, [error]);

  useEffect(() => {
    if (!displayNameTouchedRef.current) {
      setDisplayName(userName);
    }
  }, [userName]);

  useEffect(() => {
    if (!openDropdown) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openDropdown, dropdownRef]);

  const setDisplayNameFromInput = useCallback((value: string) => {
    displayNameTouchedRef.current = true;
    setDisplayName(value);
  }, []);

  const toggleVideo = useCallback(() => {
    setIsVideoEnabled((previous) => !previous);
  }, []);

  const toggleAudio = useCallback(() => {
    setIsAudioEnabled((previous) => !previous);
  }, []);

  const toggleSettings = useCallback(() => {
    setShowSettings((previous) => !previous);
  }, []);

  const handleJoin = useCallback(() => {
    const trimmedDisplayName = displayName.trim();
    if (!trimmedDisplayName) return;

    onJoin({
      displayName: trimmedDisplayName,
      videoEnabled: isVideoEnabled,
      audioEnabled: isAudioEnabled,
      selectedVideoDevice,
      selectedAudioInput,
      selectedAudioOutput,
    });
  }, [displayName, isVideoEnabled, isAudioEnabled, onJoin, selectedVideoDevice, selectedAudioInput, selectedAudioOutput]);

  return {
    displayName,
    isVideoEnabled,
    isAudioEnabled,
    showSettings,
    localError,
    openDropdown,
    canJoin: displayName.trim().length > 0,
    setIsVideoEnabled,
    setIsAudioEnabled,
    setShowSettings,
    setLocalError,
    setOpenDropdown,
    setDisplayNameFromInput,
    toggleVideo,
    toggleAudio,
    toggleSettings,
    handleJoin,
  };
}
