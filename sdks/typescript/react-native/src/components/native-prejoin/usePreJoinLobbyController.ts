import { useMemo, useSyncExternalStore } from "react";
import { usePreJoinPreview } from "../../hooks/usePreJoinPreview";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { PreJoinLobbyProps } from "../PreJoinLobby";
import { PreJoinLobbyControllerStore } from "./native-prejoin-lobby-controller-store";

export interface UsePreJoinLobbyControllerResult {
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

export function usePreJoinLobbyController({
  role = "participant",
  userName = role === "host" ? "Host" : "Guest",
  initialAudioEnabled = false,
  initialVideoEnabled = false,
  joinDisabled = false,
  onJoin,
}: Pick<PreJoinLobbyProps, "role" | "userName" | "initialAudioEnabled" | "initialVideoEnabled" | "joinDisabled" | "onJoin">): UsePreJoinLobbyControllerResult {
  const simulatorMediaDisabled = isIosSimulator();
  const store = useMemo(
    () =>
      new PreJoinLobbyControllerStore({
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
  const { previewError, previewStream } = usePreJoinPreview(snapshot.videoEnabled);

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
