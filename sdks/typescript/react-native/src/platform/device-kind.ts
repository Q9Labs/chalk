import type { ParticipantDeviceKind } from "@q9labsai/chalk-client";
import { androidDeviceKind } from "../android/call-service";
import { resolvePlatformVariant } from "./platform";

/** What this device tells the other participants it is: an iPhone or iPad from `Platform`, an Android phone, tablet or foldable from the native side. */
export function nativeDeviceKind(): ParticipantDeviceKind | undefined {
  switch (resolvePlatformVariant()) {
    case "ios-phone":
      return "iphone";
    case "ios-pad":
      return "ipad";
    case "macos":
      return "mac";
    case "android":
      return androidDeviceKind() ?? "android_phone";
    case "tvos":
      return undefined;
  }
}
