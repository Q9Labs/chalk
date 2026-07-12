import { useMemo, useSyncExternalStore } from "react";
import { usePreJoinPreview } from "../../hooks/usePreJoinPreview";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { NativePreJoinLobbyProps } from "../NativePreJoinLobby";
import { NativePreJoinLobbyControllerStore } from "./native-prejoin-lobby-controller-store";

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
  const store = useMemo(
    () =>
      new NativePreJoinLobbyControllerStore({
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
