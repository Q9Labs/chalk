import { NativeModules, Platform } from "react-native";

interface ChalkAnnotationAssets {
  readonly annotationRendererURL?: () => Promise<string>;
}

export async function annotationRendererUrl(): Promise<string | null> {
  if (Platform.OS === "android") return "file:///android_asset/chalk-annotation/index.html";
  const module = NativeModules.ChalkWhiteboardAssets as ChalkAnnotationAssets | undefined;
  const url = await module?.annotationRendererURL?.();
  return url?.startsWith("file://") ? url : null;
}
