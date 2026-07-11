import { Dimensions, Platform } from "react-native";

export type NativePlatformVariant = "android" | "ios-phone" | "ios-pad" | "macos" | "tvos";

function getIsPad(): boolean {
  const maybeIsPad = (Platform as typeof Platform & { isPad?: boolean }).isPad;
  if (typeof maybeIsPad === "boolean") {
    return maybeIsPad;
  }

  if (Platform.OS !== "ios") {
    return false;
  }

  const { width, height } = Dimensions.get("window");
  return Math.min(width, height) >= 768;
}

export function resolveNativePlatformVariant(): NativePlatformVariant {
  const platformOS = Platform.OS as string;

  switch (platformOS) {
    case "android":
      return "android";
    case "ios":
      return getIsPad() ? "ios-pad" : "ios-phone";
    case "macos":
      return "macos";
    case "tvos":
      return "tvos";
    default:
      return "android";
  }
}
