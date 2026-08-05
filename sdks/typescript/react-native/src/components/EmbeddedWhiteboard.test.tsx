import { describe, expect, it, vi } from "vitest";

const nativeTheme = vi.hoisted(() => ({
  colorScheme: "light" as const,
  colors: {
    dangerSurfaceOverlay94: "#danger",
    info: "#info",
    lightMutedText: "#muted",
    lightSubtleText: "#subtle",
    lightSurface: "#surface",
    lightText: "#text",
    onDark: "#on-dark",
  },
}));
const controllerOptions = vi.hoisted(() => [] as unknown[]);

vi.mock("react", () => ({
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void) => effect(),
  useMemo: <T,>(factory: () => T) => factory(),
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T | (() => T)): readonly [T, () => void] => [typeof initial === "function" ? (initial as () => T)() : initial, () => undefined],
}));
vi.mock("@q9labsai/chalk-whiteboard/embedded", () => ({
  ChalkWhiteboardController: class {
    constructor(options: unknown) {
      controllerOptions.push(options);
    }

    rendererReloaded(): void {}

    setCapabilities(): void {}

    setViewport(): void {}

    start(): void {}

    stop(): void {}
  },
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
vi.mock("../ui/native-theme", () => ({ useNativeTheme: () => nativeTheme }));
vi.mock("../whiteboard/embedded-whiteboard-assets", () => ({
  isEmbeddedWhiteboardNavigationAllowed: () => true,
  rendererURLWithContext: (url: string) => url,
  resolveEmbeddedWhiteboardRendererURL: async () => "file:///android_asset/chalk-whiteboard/index.html",
}));

import type { ChalkEmbeddedWhiteboardTransport } from "@q9labsai/chalk-whiteboard/embedded";
import { EmbeddedWhiteboard, embeddedWhiteboardWebViewSecurityPolicy } from "./EmbeddedWhiteboard";

describe("EmbeddedWhiteboard WebView policy", () => {
  it("keeps the offline renderer isolated from files, networks, storage, and cookies", () => {
    expect(embeddedWhiteboardWebViewSecurityPolicy).toEqual({
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

  it("uses the active NativeTheme colors throughout its loading surface", () => {
    controllerOptions.length = 0;
    const rendered = EmbeddedWhiteboard({
      canClear: false,
      canDraw: true,
      journeyId: "journey-test",
      transport: {} as ChalkEmbeddedWhiteboardTransport,
    });
    const children = rendered.props.children as readonly [{ readonly props: { readonly color: string } }, { readonly props: { readonly style: readonly unknown[] } }];

    expect(rendered.props.style).toContainEqual({ backgroundColor: "#surface" });
    expect(children[0]?.props.color).toBe("#info");
    expect(children[1]?.props.style).toContainEqual({ color: "#muted" });
    expect(controllerOptions[0]).toMatchObject({ theme: "light" });
  });
});
