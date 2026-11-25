import { NativeModules, Platform } from "react-native";

type BroadcastModule = {
  /** False on a simulator, and in an app without a broadcast extension and app group in its Info.plist. */
  readonly available?: boolean;
  start(): Promise<void>;
};

function broadcastModule(): BroadcastModule | undefined {
  return Platform.OS === "ios" ? (NativeModules.ChalkBroadcastModule as BroadcastModule | undefined) : undefined;
}

/** Whether this device can start a screen share from the app: Android's MediaProjection, or iOS's broadcast extension. */
export function canShareScreenNatively(): boolean {
  if (Platform.OS === "android") return true;
  return broadcastModule()?.available === true;
}

/**
 * Opens the iOS broadcast picker and resolves once the app's extension starts broadcasting, so the
 * WebRTC screen capturer has frames to read. A dismissed picker rejects as `NotAllowedError`.
 */
export async function startIOSScreenBroadcast(): Promise<void> {
  const native = broadcastModule();
  if (!native) throw Object.assign(new Error("Rebuild the iOS app with Chalk's native screen broadcast module"), { name: "NotSupportedError" });
  try {
    await native.start();
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && typeof cause.code === "string") cause.name = cause.code;
    throw cause;
  }
}
