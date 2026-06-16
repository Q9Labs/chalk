import { useCallback, useEffect, useRef, useState } from "react";

import type { JoinSettings } from "./types";

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
}

export interface UsePreJoinUiStateReturn {
  displayName: string;
  isVideoEnabled: boolean;
  isAudioEnabled: boolean;
  showSettings: boolean;
  localError?: string;
  canJoin: boolean;
  setIsVideoEnabled: (value: boolean) => void;
  setIsAudioEnabled: (value: boolean) => void;
  setShowSettings: (value: boolean) => void;
  setLocalError: (value: string | undefined) => void;
  setDisplayNameFromInput: (value: string) => void;
  toggleVideo: () => void;
  toggleAudio: () => void;
  toggleSettings: () => void;
  handleJoin: (displayNameOverride?: string) => void;
}

export function usePreJoinUiState({ userName, error, initialVideoEnabled, initialAudioEnabled, initialShowSettings, selectedVideoDevice, selectedAudioInput, selectedAudioOutput, onJoin }: UsePreJoinUiStateParams): UsePreJoinUiStateReturn {
  const [displayName, setDisplayName] = useState(userName);
  const [isVideoEnabled, setIsVideoEnabled] = useState(initialVideoEnabled);
  const [isAudioEnabled, setIsAudioEnabled] = useState(initialAudioEnabled);
  const [showSettings, setShowSettings] = useState(initialShowSettings);
  const [localError, setLocalError] = useState<string | undefined>(error);
  const displayNameTouchedRef = useRef(false);

  useEffect(() => {
    setLocalError(error);
  }, [error]);

  useEffect(() => {
    if (!displayNameTouchedRef.current) {
      setDisplayName(userName);
    }
  }, [userName]);

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

  const handleJoin = useCallback(
    (displayNameOverride?: string) => {
      const trimmedDisplayName = (displayNameOverride ?? displayName).trim();
      if (!trimmedDisplayName) return;

      onJoin({
        displayName: trimmedDisplayName,
        videoEnabled: isVideoEnabled,
        audioEnabled: isAudioEnabled,
        selectedVideoDevice,
        selectedAudioInput,
        selectedAudioOutput,
      });
    },
    [displayName, isVideoEnabled, isAudioEnabled, onJoin, selectedVideoDevice, selectedAudioInput, selectedAudioOutput],
  );

  return {
    displayName,
    isVideoEnabled,
    isAudioEnabled,
    showSettings,
    localError,
    canJoin: displayName.trim().length > 0,
    setIsVideoEnabled,
    setIsAudioEnabled,
    setShowSettings,
    setLocalError,
    setDisplayNameFromInput,
    toggleVideo,
    toggleAudio,
    toggleSettings,
    handleJoin,
  };
}
