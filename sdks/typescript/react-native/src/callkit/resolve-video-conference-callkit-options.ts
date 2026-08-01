import type { CallKitCallOptions, CallKitConfiguration, CallKitHandleType } from "./callkit";

export interface VideoConferenceCallKitOptions extends CallKitConfiguration {
  displayName?: string;
  enabled?: boolean;
  handle?: string;
  handleType?: CallKitHandleType;
  hasVideo?: boolean;
}

export interface ResolvedVideoConferenceCallKitOptions extends CallKitConfiguration, Pick<CallKitCallOptions, "displayName" | "handle" | "handleType" | "hasVideo"> {}

export function resolveVideoConferenceCallKitOptions({ callKit, hasVideo, roomId, roomName }: { callKit?: VideoConferenceCallKitOptions | boolean; hasVideo: boolean; roomId: string; roomName?: string }): ResolvedVideoConferenceCallKitOptions | null {
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
