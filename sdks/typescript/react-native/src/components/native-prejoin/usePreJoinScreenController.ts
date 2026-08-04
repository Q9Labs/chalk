import { useMemo, useSyncExternalStore } from "react";
import { usePreJoinPreview } from "../../hooks/usePreJoinPreview";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { PreJoinScreenProps } from "../PreJoinScreen";
import { PreJoinScreenControllerStore } from "./native-prejoin-lobby-controller-store";

export interface UsePreJoinScreenControllerResult {
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

export function usePreJoinScreenController({
  role = "participant",
  userName = role === "host" ? "Host" : "Guest",
  initialAudioEnabled = false,
  initialVideoEnabled = false,
  joinDisabled = false,
  previewMode = "device",
  onJoin,
}: Pick<PreJoinScreenProps, "role" | "userName" | "initialAudioEnabled" | "initialVideoEnabled" | "joinDisabled" | "previewMode" | "onJoin">): UsePreJoinScreenControllerResult {
  const simulatorMediaDisabled = isIosSimulator();
  const store = useMemo(
    () =>
      new PreJoinScreenControllerStore({
        displayName: userName,
        initialAudioEnabled,
        initialVideoEnabled,
        simulatorMediaDisabled,
        joinDisabled,
        onJoin,
      }),
    [],
  );
  store.update({
    simulatorMediaDisabled,
    joinDisabled,
    onJoin,
  });
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { previewError, previewStream } = usePreJoinPreview(snapshot.videoEnabled, previewMode);

  return {
    displayName: snapshot.displayName,
    audioEnabled: snapshot.audioEnabled,
    videoEnabled: snapshot.videoEnabled,
    isSubmitting: snapshot.isSubmitting,
    isInputFocused: snapshot.isInputFocused,
    previewError,
    previewStream,
    simulatorMediaDisabled,
    setDisplayName: store.setDisplayName,
    setInputFocused: store.setInputFocused,
    toggleAudio: store.toggleAudio,
    toggleVideo: store.toggleVideo,
    handleJoin: store.handleJoin,
  };
}
