import type { PreJoinSettings } from "./PreJoinLobby";

export function resolveNativeJoinDefaults({ initialJoinSettings, simulatorMediaDisabled, userName }: { initialJoinSettings?: Partial<PreJoinSettings>; simulatorMediaDisabled: boolean; userName?: string }): PreJoinSettings {
  return {
    displayName: initialJoinSettings?.displayName?.trim() || userName || "Chalker",
    microphoneEnabled: simulatorMediaDisabled ? false : (initialJoinSettings?.microphoneEnabled ?? false),
    cameraEnabled: simulatorMediaDisabled ? false : (initialJoinSettings?.cameraEnabled ?? false),
  };
}
