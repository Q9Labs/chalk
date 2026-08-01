import type { JoinSettings } from "./PreJoinLobby";

export function resolveNativeJoinDefaults({ initialJoinSettings, simulatorMediaDisabled, userName }: { initialJoinSettings?: Partial<JoinSettings>; simulatorMediaDisabled: boolean; userName?: string }): JoinSettings {
  return {
    displayName: initialJoinSettings?.displayName?.trim() || userName || "Chalker",
    audioEnabled: simulatorMediaDisabled ? false : (initialJoinSettings?.audioEnabled ?? false),
    videoEnabled: simulatorMediaDisabled ? false : (initialJoinSettings?.videoEnabled ?? false),
  };
}
