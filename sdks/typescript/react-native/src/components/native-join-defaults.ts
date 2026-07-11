import type { NativeJoinSettings } from "./NativePreJoinLobby";

export function resolveNativeJoinDefaults({ initialJoinSettings, simulatorMediaDisabled, userName }: { initialJoinSettings?: Partial<NativeJoinSettings>; simulatorMediaDisabled: boolean; userName?: string }): NativeJoinSettings {
  return {
    displayName: initialJoinSettings?.displayName?.trim() || userName || "Chalker",
    audioEnabled: simulatorMediaDisabled ? false : (initialJoinSettings?.audioEnabled ?? false),
    videoEnabled: simulatorMediaDisabled ? false : (initialJoinSettings?.videoEnabled ?? false),
  };
}
