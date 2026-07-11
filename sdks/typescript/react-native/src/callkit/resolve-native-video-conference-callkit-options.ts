import type { NativeCallKitCallOptions, NativeCallKitConfiguration, NativeCallKitHandleType } from "./native-callkit";

export interface NativeVideoConferenceCallKitOptions extends NativeCallKitConfiguration {
  displayName?: string;
  enabled?: boolean;
  handle?: string;
  handleType?: NativeCallKitHandleType;
  hasVideo?: boolean;
}

export interface ResolvedNativeVideoConferenceCallKitOptions extends NativeCallKitConfiguration, Pick<NativeCallKitCallOptions, "displayName" | "handle" | "handleType" | "hasVideo"> {}

export function resolveNativeVideoConferenceCallKitOptions({ callKit, hasVideo, roomId, roomName }: { callKit?: NativeVideoConferenceCallKitOptions | boolean; hasVideo: boolean; roomId: string; roomName?: string }): ResolvedNativeVideoConferenceCallKitOptions | null {
  if (!callKit || (typeof callKit === "object" && callKit.enabled === false)) {
    return null;
  }

  const options = typeof callKit === "object" ? callKit : {};
  const fallbackDisplayName = roomName?.trim() || roomId;
  const fallbackHandle = roomId;

  return {
    appName: options.appName?.trim() || "Chalk",
    displayName: options.displayName?.trim() || fallbackDisplayName,
    handle: options.handle?.trim() || fallbackHandle,
    handleType: options.handleType ?? "generic",
    hasVideo: options.hasVideo ?? hasVideo,
    iconTemplateImageName: options.iconTemplateImageName?.trim() || undefined,
    includesCallsInRecents: options.includesCallsInRecents ?? false,
    maximumCallGroups: options.maximumCallGroups ?? 1,
    maximumCallsPerCallGroup: options.maximumCallsPerCallGroup ?? 1,
    ringtoneSound: options.ringtoneSound?.trim() || undefined,
  };
}
