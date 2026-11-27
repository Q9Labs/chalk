import type { ParticipantDeviceKind } from "@q9labsai/chalk-client";
import { NativeModules, Platform } from "react-native";

type NativeCallServiceModule = {
  readonly start: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
  /** Read once by the native side: a foldable, a tablet (smallest width of 600dp or more) or a phone. */
  readonly deviceKind?: "android_phone" | "android_tablet" | "android_foldable";
};

const nativeModule: NativeCallServiceModule | undefined = NativeModules.ChalkCallService;

/** Starts the Android foreground service for the call. Resolves false when there's nothing to keep running (no microphone or camera permission) or Android refused the start. */
export async function startAndroidCallService(): Promise<boolean> {
  if (Platform.OS !== "android" || !nativeModule) return false;
  return nativeModule.start();
}

export async function stopAndroidCallService(): Promise<void> {
  if (Platform.OS !== "android" || !nativeModule) return;
  await nativeModule.stop();
}

/** The kind of Android device this is, or undefined when the app has not linked the native module. */
export function androidDeviceKind(): ParticipantDeviceKind | undefined {
  return Platform.OS === "android" ? nativeModule?.deviceKind : undefined;
}
