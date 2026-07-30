import { NativeModules, Platform } from "react-native";

const ANDROID_RENDERER_URL = "file:///android_asset/chalk-whiteboard/index.html";

interface ChalkWhiteboardAssetsNativeModule {
  readonly rendererURL: () => Promise<string>;
}

export async function resolveEmbeddedWhiteboardRendererURL(override?: string): Promise<string> {
  if (override) return requireLocalRendererURL(override);
  if (Platform.OS === "android") return ANDROID_RENDERER_URL;

  const module = NativeModules.ChalkWhiteboardAssets as ChalkWhiteboardAssetsNativeModule | undefined;
  if (!module?.rendererURL) throw new Error(`Chalk embedded whiteboard assets are unavailable on ${Platform.OS}`);
  return requireLocalRendererURL(await module.rendererURL());
}

export function rendererURLWithContext(rendererURL: string, context: { readonly journeyId: string; readonly rendererGeneration: string }): string {
  const separator = rendererURL.includes("?") ? "&" : "?";
  return `${rendererURL}${separator}journeyId=${encodeURIComponent(context.journeyId)}&rendererGeneration=${encodeURIComponent(context.rendererGeneration)}`;
}

export function isEmbeddedWhiteboardNavigationAllowed(requestURL: string, rendererURL: string): boolean {
  if (requestURL === "about:blank") return true;
  try {
    const renderer = new URL(rendererURL);
    const request = new URL(requestURL);
    if (renderer.protocol !== "file:" || request.protocol !== "file:" || request.host !== renderer.host) return false;
    const requestPath = decodeURIComponent(request.pathname);
    if (requestPath.split("/").includes("..")) return false;
    const rendererDirectory = renderer.pathname.slice(0, renderer.pathname.lastIndexOf("/") + 1);
    return request.pathname === renderer.pathname || request.pathname.startsWith(rendererDirectory);
  } catch {
    return false;
  }
}

function requireLocalRendererURL(value: string): string {
  if (!value.startsWith("file://")) throw new Error("Chalk embedded whiteboard renderer must be a local file URL");
  return value;
}
