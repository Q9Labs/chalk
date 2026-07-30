import { ChalkWhiteboardController, type ChalkEmbeddedWhiteboardTransport, type ChalkEmbeddedWhiteboardViewport } from "@q9labsai/chalk-whiteboard/embedded";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from "react-native";
import WebView, { type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";

import { isEmbeddedWhiteboardNavigationAllowed, rendererURLWithContext, resolveEmbeddedWhiteboardRendererURL } from "../whiteboard/embedded-whiteboard-assets";

export interface ChalkEmbeddedWhiteboardProps {
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

export const chalkEmbeddedWhiteboardWebViewSecurityPolicy = Object.freeze({
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

export function ChalkEmbeddedWhiteboard({ transport, journeyId, traceparent, tracestate, canDraw, canClear, theme = "light", localParticipantColor, rendererURL: rendererURLOverride, style, testID, onMetric, onError, onUserExport }: ChalkEmbeddedWhiteboardProps): React.JSX.Element {
  const webViewRef = useRef<WebView>(null);
  const controllerRef = useRef<ChalkWhiteboardController | null>(null);
  const listenersRef = useRef(new Set<(message: string) => void>());
  const [rendererURL, setRendererURL] = useState<string | null>(null);
  const [rendererGeneration, setRendererGeneration] = useState(createRendererGeneration);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [compatibilityNotice, setCompatibilityNotice] = useState<string | null>(null);
  const { width, height, scale } = useWindowDimensions();

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
  const handleControllerError = useCallback(
    (error: { readonly code: string; readonly message: string; readonly recoverable: boolean }) => {
      onError?.(error);
    },
    [onError],
  );

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
  }, [loadAttempt, onError, rendererURLOverride]);

  useEffect(() => {
    setCompatibilityNotice(null);
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
      ...(onMetric ? { onMetric } : {}),
      onError: handleControllerError,
      onCompatibilityChange: (state) => setCompatibilityNotice(state.message),
      ...(onUserExport ? { onUserExport } : {}),
    });
    controller.start();
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.stop();
    };
  }, [handleControllerError, journeyId, localParticipantColor, onMetric, onUserExport, rendererPort, theme, traceparent, tracestate, transport]);

  useEffect(() => {
    controllerRef.current?.setCapabilities({ canDraw, canClear });
  }, [canClear, canDraw]);

  const viewport = useMemo<ChalkEmbeddedWhiteboardViewport>(() => ({ width, height, scale }), [height, scale, width]);
  useEffect(() => {
    controllerRef.current?.setViewport(viewport);
  }, [viewport]);

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
  const retryRenderer = (): void => {
    setLoadError(null);
    setLoadAttempt((attempt) => attempt + 1);
    reloadRenderer();
  };
  const handleRendererTermination = (): void => {
    onMetric?.({ name: "whiteboard.renderer.termination", value: 1 });
    onError?.({
      code: "renderer_terminated",
      message: "The whiteboard renderer stopped and is recovering.",
      recoverable: true,
    });
    reloadRenderer();
  };

  if (loadError) {
    return (
      <View style={[styles.status, style]} testID={testID}>
        <Text style={styles.errorTitle}>Whiteboard unavailable</Text>
        <Text style={styles.errorMessage}>{loadError}</Text>
        <Pressable accessibilityRole="button" onPress={retryRenderer} style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (!sourceURL || !rendererURL) {
    return (
      <View style={[styles.status, style]} testID={testID}>
        <ActivityIndicator color="#0ea5e9" />
        <Text style={styles.loadingMessage}>Loading whiteboard…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, style]} testID={testID}>
      <WebView
        key={rendererGeneration}
        ref={webViewRef}
        {...chalkEmbeddedWhiteboardWebViewSecurityPolicy}
        allowingReadAccessToURL={rendererURL.slice(0, rendererURL.lastIndexOf("/") + 1)}
        mediaPlaybackRequiresUserAction
        onContentProcessDidTerminate={handleRendererTermination}
        onError={(event) => {
          const message = event.nativeEvent.description || "The whiteboard renderer failed to load";
          setLoadError(message);
          onError?.({ code: "renderer_load_failed", message, recoverable: true });
        }}
        onMessage={handleMessage}
        onRenderProcessGone={handleRendererTermination}
        onShouldStartLoadWithRequest={allowNavigation}
        originWhitelist={["file://*"]}
        pullToRefreshEnabled={false}
        scrollEnabled={false}
        source={{ uri: sourceURL }}
        style={styles.webView}
        webviewDebuggingEnabled={typeof __DEV__ !== "undefined" && __DEV__}
      />
      {compatibilityNotice ? (
        <View pointerEvents="none" style={styles.compatibilityNotice}>
          <Text style={styles.compatibilityNoticeText}>{compatibilityNotice}</Text>
        </View>
      ) : null}
    </View>
  );
}

function createRendererGeneration(): string {
  return globalThis.crypto?.randomUUID?.() ?? `whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: "hidden",
  },
  webView: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  compatibilityNotice: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(127, 29, 29, 0.94)",
  },
  compatibilityNoticeText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
  status: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 24,
    backgroundColor: "#ffffff",
  },
  loadingMessage: {
    color: "#475569",
    fontSize: 14,
    fontWeight: "600",
  },
  errorTitle: {
    color: "#0f172a",
    fontSize: 17,
    fontWeight: "700",
  },
  errorMessage: {
    color: "#64748b",
    fontSize: 13,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#0ea5e9",
  },
  retryButtonPressed: {
    opacity: 0.75,
  },
  retryButtonText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
});
