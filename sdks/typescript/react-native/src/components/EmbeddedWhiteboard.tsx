import { ChalkWhiteboardController, type ChalkEmbeddedWhiteboardTransport, type ChalkEmbeddedWhiteboardViewport } from "@q9labsai/chalk-whiteboard/embedded";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import WebView, { type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";

import { isEmbeddedWhiteboardNavigationAllowed, rendererURLWithContext, resolveEmbeddedWhiteboardRendererURL } from "../whiteboard/embedded-whiteboard-assets";
import { createEmbeddedWhiteboardViewport } from "../whiteboard/embedded-whiteboard-viewport";

export interface EmbeddedWhiteboardProps {
  readonly transport: ChalkEmbeddedWhiteboardTransport;
  readonly journeyId: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly theme?: "light" | "dark";
  readonly localParticipantColor?: string;
  readonly rendererURL?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
  readonly onMetric?: (metric: { readonly name: string; readonly value: number; readonly attributes?: Readonly<Record<string, string | number | boolean>> }) => void;
  readonly onError?: (error: { readonly code: string; readonly message: string; readonly recoverable: boolean }) => void;
  readonly onUserExport?: (value: { readonly requestId: string; readonly format: "png" | "svg"; readonly mimeType: string; readonly dataURL: string }) => void;
}

export const embeddedWhiteboardWebViewSecurityPolicy = Object.freeze({
  allowFileAccess: true,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  cacheEnabled: false,
  domStorageEnabled: false,
  javaScriptCanOpenWindowsAutomatically: false,
  javaScriptEnabled: true,
  mixedContentMode: "never" as const,
  setSupportMultipleWindows: false,
  sharedCookiesEnabled: false,
  thirdPartyCookiesEnabled: false,
});

export function EmbeddedWhiteboard({ transport, journeyId, traceparent, tracestate, canDraw, canClear, theme: themeOverride, localParticipantColor, rendererURL: rendererURLOverride, style, testID, onMetric, onError, onUserExport }: EmbeddedWhiteboardProps): React.JSX.Element {
  const theme = themeOverride ?? "light";
  const webViewRef = useRef<WebView>(null);
  const controllerRef = useRef<ChalkWhiteboardController | null>(null);
  const listenersRef = useRef(new Set<(message: string) => void>());
  const onMetricRef = useRef(onMetric);
  const onErrorRef = useRef(onError);
  const onUserExportRef = useRef(onUserExport);
  const [rendererURL, setRendererURL] = useState<string | null>(null);
  const [rendererGeneration, setRendererGeneration] = useState(createRendererGeneration);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const { scale } = useWindowDimensions();
  const viewport = useMemo<ChalkEmbeddedWhiteboardViewport | null>(() => createEmbeddedWhiteboardViewport(layout.width, layout.height, scale), [layout.height, layout.width, scale]);
  const latestViewportRef = useRef(viewport);
  latestViewportRef.current = viewport;
  onMetricRef.current = onMetric;
  onErrorRef.current = onError;
  onUserExportRef.current = onUserExport;

  const rendererPort = useMemo(
    () => ({
      postMessage: (message: string) => webViewRef.current?.postMessage(message),
      subscribe: (listener: (message: string) => void) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
    }),
    [],
  );
  const handleControllerError = useCallback((error: { readonly code: string; readonly message: string; readonly recoverable: boolean }) => onErrorRef.current?.(error), []);
  const handleControllerMetric = useCallback((metric: { readonly name: string; readonly value: number; readonly attributes?: Readonly<Record<string, string | number | boolean>> }) => onMetricRef.current?.(metric), []);
  const handleControllerUserExport = useCallback((value: { readonly requestId: string; readonly format: "png" | "svg"; readonly mimeType: string; readonly dataURL: string }) => onUserExportRef.current?.(value), []);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    void resolveEmbeddedWhiteboardRendererURL(rendererURLOverride)
      .then((url) => {
        if (active) setRendererURL(url);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const message = cause instanceof Error ? cause.message : "Chalk whiteboard assets are unavailable";
        setLoadError(message);
        onError?.({ code: "renderer_asset_unavailable", message, recoverable: false });
      });
    return () => {
      active = false;
    };
  }, [onError, rendererURLOverride]);

  useEffect(() => {
    const controller = new ChalkWhiteboardController({
      renderer: rendererPort,
      transport,
      journeyId,
      ...(traceparent ? { traceparent } : {}),
      ...(tracestate ? { tracestate } : {}),
      canDraw,
      canClear,
      theme,
      ...(localParticipantColor ? { localParticipantColor } : {}),
      onMetric: handleControllerMetric,
      onError: handleControllerError,
      onUserExport: handleControllerUserExport,
    });
    controller.start();
    if (latestViewportRef.current) controller.setViewport(latestViewportRef.current);
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.stop();
    };
  }, [handleControllerError, handleControllerMetric, handleControllerUserExport, journeyId, localParticipantColor, rendererPort, theme, traceparent, tracestate, transport]);

  useEffect(() => {
    controllerRef.current?.setCapabilities({ canDraw, canClear });
  }, [canClear, canDraw]);

  useEffect(() => {
    if (viewport) controllerRef.current?.setViewport(viewport);
  }, [viewport]);
  const handleLayout = useCallback((event: LayoutChangeEvent): void => {
    const next = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
    setLayout((current) => (current.width === next.width && current.height === next.height ? current : next));
  }, []);

  const sourceURL = rendererURL ? rendererURLWithContext(rendererURL, { journeyId, rendererGeneration }) : null;
  const handleMessage = (event: WebViewMessageEvent): void => {
    const message = event.nativeEvent.data;
    listenersRef.current.forEach((listener) => listener(message));
  };
  const allowNavigation = (request: WebViewNavigation): boolean => Boolean(rendererURL && isEmbeddedWhiteboardNavigationAllowed(request.url, rendererURL));
  const reloadRenderer = (): void => {
    controllerRef.current?.rendererReloaded();
    setRendererGeneration(createRendererGeneration());
  };
  const handleRendererTermination = (): void => {
    handleControllerMetric({ name: "whiteboard.renderer.termination", value: 1 });
    handleControllerError({
      code: "renderer_terminated",
      message: "The whiteboard renderer stopped and is recovering.",
      recoverable: true,
    });
    reloadRenderer();
  };

  if (loadError || !sourceURL || !rendererURL) return <View style={[{ flex: 1 }, style]} testID={testID} />;

  return (
    <View onLayout={handleLayout} style={[{ flex: 1 }, style]} testID={testID}>
      <WebView
        key={rendererGeneration}
        ref={webViewRef}
        {...embeddedWhiteboardWebViewSecurityPolicy}
        allowingReadAccessToURL={rendererURL.slice(0, rendererURL.lastIndexOf("/") + 1)}
        mediaPlaybackRequiresUserAction
        onContentProcessDidTerminate={handleRendererTermination}
        onError={(event) => {
          const message = event.nativeEvent.description || "The whiteboard renderer failed to load";
          setLoadError(message);
          handleControllerError({ code: "renderer_load_failed", message, recoverable: true });
        }}
        onMessage={handleMessage}
        onRenderProcessGone={handleRendererTermination}
        onShouldStartLoadWithRequest={allowNavigation}
        originWhitelist={["file://*"]}
        pullToRefreshEnabled={false}
        scrollEnabled={false}
        source={{ uri: sourceURL }}
        style={{ flex: 1 }}
        webviewDebuggingEnabled={typeof __DEV__ !== "undefined" && __DEV__}
      />
    </View>
  );
}

function createRendererGeneration(): string {
  return globalThis.crypto?.randomUUID?.() ?? `whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
