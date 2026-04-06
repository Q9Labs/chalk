import { useEffect, useRef, useState } from "react";
import { usePreJoinPreview } from "../../hooks/usePreJoinPreview";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { NativeJoinSettings, NativePreJoinLobbyProps } from "../NativePreJoinLobby";

export interface UseNativePreJoinLobbyControllerResult {
  displayName: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  isSubmitting: boolean;
  isInputFocused: boolean;
  previewError: string | null;
  previewStream: ReturnType<typeof usePreJoinPreview>["previewStream"];
  simulatorMediaDisabled: boolean;
  setDisplayName: (value: string) => void;
  setInputFocused: (focused: boolean) => void;
  toggleAudio: () => void;
  toggleVideo: () => void;
  handleJoin: () => void;
}

export function useNativePreJoinLobbyController({
  role = "participant",
  userName = role === "host" ? "Host" : "Guest",
  initialAudioEnabled = false,
  initialVideoEnabled = false,
  joinDisabled = false,
  onJoin,
}: Pick<NativePreJoinLobbyProps, "role" | "userName" | "initialAudioEnabled" | "initialVideoEnabled" | "joinDisabled" | "onJoin">): UseNativePreJoinLobbyControllerResult {
  const simulatorMediaDisabled = isIosSimulator();
  const [displayName, setDisplayName] = useState(userName);
  const [audioEnabled, setAudioEnabled] = useState(initialAudioEnabled && !simulatorMediaDisabled);
  const [videoEnabled, setVideoEnabled] = useState(initialVideoEnabled && !simulatorMediaDisabled);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isInputFocused, setInputFocused] = useState(false);
  const submitLatchRef = useRef(false);
  const { previewError, previewStream } = usePreJoinPreview(videoEnabled);

  useEffect(() => {
    if (simulatorMediaDisabled) {
      setAudioEnabled(false);
      setVideoEnabled(false);
    }
  }, [simulatorMediaDisabled]);

  useEffect(() => {
    if (!joinDisabled) {
      submitLatchRef.current = false;
      setIsSubmitting(false);
    }
  }, [joinDisabled]);

  const toggleAudio = () => {
    if (simulatorMediaDisabled) {
      return;
    }
    setAudioEnabled((current) => !current);
  };

  const toggleVideo = () => {
    if (simulatorMediaDisabled) {
      return;
    }
    setVideoEnabled((current) => !current);
  };

  const handleJoin = () => {
    if (joinDisabled || isSubmitting || submitLatchRef.current) {
      return;
    }

    submitLatchRef.current = true;
    setIsSubmitting(true);

    const settings: NativeJoinSettings = {
      displayName,
      audioEnabled,
      videoEnabled,
    };
    onJoin(settings);
  };

  return {
    displayName,
    audioEnabled,
    videoEnabled,
    isSubmitting,
    isInputFocused,
    previewError,
    previewStream,
    simulatorMediaDisabled,
    setDisplayName,
    setInputFocused,
    toggleAudio,
    toggleVideo,
    handleJoin,
  };
}
