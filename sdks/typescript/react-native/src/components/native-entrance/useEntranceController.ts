import { useMemo, useSyncExternalStore } from "react";
import { useEntrancePreview } from "../../hooks/useEntrancePreview";
import { isIosSimulator } from "../../utils/ios-simulator";
import type { EntranceViewProps } from "../EntranceView";
import { EntranceControllerStore } from "./entrance-controller-store";

export interface UseEntranceControllerResult {
  displayName: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  isSubmitting: boolean;
  isInputFocused: boolean;
  previewError: string | null;
  previewStream: ReturnType<typeof useEntrancePreview>["previewStream"];
  simulatorMediaDisabled: boolean;
  setDisplayName: (value: string) => void;
  setInputFocused: (focused: boolean) => void;
  toggleAudio: () => void;
  toggleVideo: () => void;
  handleJoin: () => void;
}

export function useEntranceController({ displayName = "", initialAudioEnabled = false, initialVideoEnabled = false, joinDisabled = false, onJoin }: Pick<EntranceViewProps, "displayName" | "initialAudioEnabled" | "initialVideoEnabled" | "joinDisabled" | "onJoin">): UseEntranceControllerResult {
  const simulatorMediaDisabled = isIosSimulator();
  const store = useMemo(
    () =>
      new EntranceControllerStore({
        displayName,
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
  const { previewError, previewStream } = useEntrancePreview(snapshot.videoEnabled);

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
