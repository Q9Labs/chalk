import { describe, expect, it, vi } from "vitest";

vi.mock("@q9labsai/chalk-whiteboard/embedded", () => ({
  ChalkWhiteboardController: class {},
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 320, height: 640, scale: 2 }),
}));
vi.mock("react-native-webview", () => ({ default: "WebView" }));
vi.mock("../whiteboard/embedded-whiteboard-assets", () => ({
  isEmbeddedWhiteboardNavigationAllowed: () => true,
  rendererURLWithContext: (url: string) => url,
  resolveEmbeddedWhiteboardRendererURL: async () => "file:///android_asset/chalk-whiteboard/index.html",
}));

import { chalkEmbeddedWhiteboardWebViewSecurityPolicy } from "./ChalkEmbeddedWhiteboard";

describe("ChalkEmbeddedWhiteboard WebView policy", () => {
  it("keeps the offline renderer isolated from files, networks, storage, and cookies", () => {
    expect(chalkEmbeddedWhiteboardWebViewSecurityPolicy).toEqual({
      allowFileAccess: true,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      cacheEnabled: false,
      domStorageEnabled: false,
      javaScriptCanOpenWindowsAutomatically: false,
      javaScriptEnabled: true,
      mixedContentMode: "never",
      setSupportMultipleWindows: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
    });
  });
});
