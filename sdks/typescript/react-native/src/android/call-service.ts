import { NativeModules, Platform } from "react-native";

type NativeCallServiceModule = {
  readonly start: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
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
